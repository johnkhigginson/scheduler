using System.Net.Http.Headers;
using System.Text.Json;

namespace DraftPoll;

/// <summary>
/// Sends the sign in email through Postmark. Deliberately tiny: one message type, no templates, no
/// SDK. An unset token disables sending rather than failing at the call site, so the app still runs
/// locally without credentials.
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
            "Here is your sign in link for Scheduler.\n\n" + link +
            "\n\nIt works once and expires in 15 minutes. If you did not ask for it, ignore this email.\n";

        var html =
            "<p>Here is your sign in link for Scheduler.</p>" +
            "<p><a href=\"" + link + "\">Sign in</a></p>" +
            "<p>It works once and expires in 15 minutes. If you did not ask for it, ignore this email.</p>" +
            "<p style=\"color:#5c6b7a;font-size:13px\">" + link + "</p>";

        var payload = JsonSerializer.Serialize(new
        {
            From = _from,
            To = to,
            Subject = "Your Scheduler sign in link",
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
            // the failure worth seeing in the log.
            var body = await response.Content.ReadAsStringAsync();
            _log.LogError("Postmark refused the sign in email: {Status} {Body}", (int)response.StatusCode, body);
            return false;
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Could not reach Postmark to send a sign in email.");
            return false;
        }
    }
}
