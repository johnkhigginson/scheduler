using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;

namespace DraftPoll;

/// <summary>
/// Sends email through Postmark. Deliberately tiny: two message types, no templates, no SDK. An unset
/// token disables sending rather than failing at the call site, so the app still runs locally without
/// credentials.
/// </summary>
public sealed class Mailer
{
    private readonly HttpClient _http;
    private readonly ILogger<Mailer> _log;
    private readonly string? _token;
    private readonly string _from;

    public Mailer(HttpClient http, IConfiguration config, ILogger<Mailer> log)
    {
        _http = http;
        _log = log;
        _token = config["Postmark:Token"];
        _from = config["Postmark:From"] ?? "noreply@sdw.dev";
    }

    public bool Enabled => !string.IsNullOrEmpty(_token);

    public async Task<bool> SendSignInLinkAsync(string to, string link)
    {
        if (!Enabled)
        {
            _log.LogWarning("No Postmark token configured, so no sign in email was sent to {To}.", to);
            return false;
        }

        var text =
            "Here is your sign in link for " + Site.Name + ".\n\n" + link +
            "\n\nIt works once and expires in 15 minutes. If you did not ask for it, ignore this email.\n";

        var html =
            "<p>Here is your sign in link for " + Site.Name + ".</p>" +
            "<p><a href=\"" + link + "\">Sign in</a></p>" +
            "<p>It works once and expires in 15 minutes. If you did not ask for it, ignore this email.</p>" +
            "<p style=\"color:#5c6b7a;font-size:13px\">" + link + "</p>";

        return await SendAsync(to, "Your " + Site.Name + " sign in link", text, html, "sign in", logBody: true);
    }

    /// <summary>
    /// The share link and organizer link for a poll that was just made. Nothing about this send is
    /// stored, so the address is kept out of the log too: logging it would make the log the one
    /// place that remembers it.
    /// </summary>
    public async Task<bool> SendPollLinksAsync(string to, string title, string publicUrl, string adminUrl)
    {
        if (!Enabled)
        {
            _log.LogWarning("No Postmark token configured, so a poll links email was not sent.");
            return false;
        }

        var text =
            "Your " + Site.Name + " poll: " + title + "\n\n" +
            "Share this link with everyone:\n" + publicUrl + "\n\n" +
            "Organizer link, keep this private. It is the only way back into the controls:\n" + adminUrl +
            "\n\nYou asked for this email on the page that created the poll. If you did not, ignore it.\n";

        // The title is user text, so it is encoded before it goes anywhere near the HTML body.
        var safeTitle = WebUtility.HtmlEncode(title);
        var html =
            "<p>Your " + Site.Name + " poll: <strong>" + safeTitle + "</strong></p>" +
            "<p>Share this link with everyone:<br><a href=\"" + publicUrl + "\">" + publicUrl + "</a></p>" +
            "<p>Organizer link, keep this private. It is the only way back into the controls:<br>" +
            "<a href=\"" + adminUrl + "\">" + adminUrl + "</a></p>" +
            "<p style=\"color:#5c6b7a;font-size:13px\">You asked for this email on the page that created the poll. If you did not, ignore it.</p>";

        // A line break in a subject is not valid, and a title can carry one.
        var subject = "Your " + Site.Name + " poll links: " + title.ReplaceLineEndings(" ");
        return await SendAsync(to, subject, text, html, "poll links", logBody: false);
    }

    private async Task<bool> SendAsync(string to, string subject, string text, string html, string kind, bool logBody)
    {
        var payload = JsonSerializer.Serialize(new
        {
            From = _from,
            To = to,
            Subject = subject,
            TextBody = text,
            HtmlBody = html,
            MessageStream = "outbound"
        });

        using var request = new HttpRequestMessage(HttpMethod.Post, "https://api.postmarkapp.com/email");
        request.Headers.Add("X-Postmark-Server-Token", _token);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Content = new StringContent(payload, System.Text.Encoding.UTF8, "application/json");

        try
        {
            using var response = await _http.SendAsync(request);
            if (response.IsSuccessStatusCode) return true;

            // The body carries Postmark's reason, such as an unverified sender signature, which is
            // the failure worth seeing in the log. It can also quote the recipient, so it is left out
            // for sends whose address is meant to leave no trace.
            var body = logBody ? await response.Content.ReadAsStringAsync() : "(body not logged)";
            _log.LogError("Postmark refused the {Kind} email: {Status} {Body}", kind, (int)response.StatusCode, body);
            return false;
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Could not reach Postmark to send a {Kind} email.", kind);
            return false;
        }
    }
}
