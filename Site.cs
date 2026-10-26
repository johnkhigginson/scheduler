using System.Net;
using System.Text;
using System.Text.RegularExpressions;

namespace DraftPoll;

/// <summary>Public site details, and the one part of the poll page the server fills in.</summary>
public static class Site
{
    /// <summary>
    /// The user facing product name, for everything the server writes: share tags and email.
    /// Internal names stay DraftPoll. See the rebrand checklist in CLAUDE.md for the rest.
    /// </summary>
    public const string Name = "Scheduler";

    /// <summary>
    /// Share tags and canonical links have to be absolute, and they should name the public site
    /// whichever host the request happened to arrive on.
    /// </summary>
    public const string Origin = "https://scheduler.sdw.dev";

    // TODO(john): support email. Empty on purpose, and rendered nowhere while it is. The privacy
    // and terms pages point people at GitHub issues until a real address exists.
    public const string SupportEmail = "";

    private const string ShareStart = "<!-- share tags -->";
    private const string ShareEnd = "<!-- /share tags -->";

    /// <summary>
    /// Splits poll.html around its share tag block once at startup, so serving a poll page is two
    /// string concatenations rather than a file read and a search on every request.
    /// </summary>
    public static (string Head, string Tail) LoadPollPage(string path)
    {
        var html = File.ReadAllText(path);
        var start = html.IndexOf(ShareStart, StringComparison.Ordinal);
        var end = html.IndexOf(ShareEnd, StringComparison.Ordinal);
        if (start < 0 || end < start)
            throw new InvalidOperationException("poll.html is missing its share tag markers.");

        return (html[..start], html[(end + ShareEnd.Length)..]);
    }

    /// <summary>
    /// Title and link preview tags for one poll, or generic ones when the id matches nothing. Only
    /// the title, description and public id are used, and every user value is HTML encoded.
    /// </summary>
    public static string ShareTags(Poll? poll)
    {
        var title = poll is null ? Name + " poll" : poll.Title + " | " + Name;
        var shareTitle = poll?.Title ?? "A date poll on " + Name;
        var description = poll is null
            ? "Mark yes or no on each date and see which one works for everyone. Free, no sign-up."
            : Summary(poll);
        var url = poll is null ? Origin + "/" : Origin + "/p/" + poll.PublicId;

        static string e(string value) => WebUtility.HtmlEncode(value);

        var html = new StringBuilder();
        html.Append("<title>").Append(e(title)).Append("</title>\n");
        html.Append("<meta name=\"description\" content=\"").Append(e(description)).Append("\">\n");
        html.Append("<meta property=\"og:type\" content=\"website\">\n");
        html.Append("<meta property=\"og:site_name\" content=\"").Append(e(Name)).Append("\">\n");
        html.Append("<meta property=\"og:title\" content=\"").Append(e(shareTitle)).Append("\">\n");
        html.Append("<meta property=\"og:description\" content=\"").Append(e(description)).Append("\">\n");
        html.Append("<meta property=\"og:url\" content=\"").Append(e(url)).Append("\">\n");
        html.Append("<meta property=\"og:image\" content=\"").Append(Origin).Append("/og.png\">\n");
        html.Append("<meta property=\"og:image:width\" content=\"1200\">\n");
        html.Append("<meta property=\"og:image:height\" content=\"630\">\n");
        html.Append("<meta name=\"twitter:card\" content=\"summary_large_image\">\n");
        html.Append("<meta name=\"twitter:title\" content=\"").Append(e(shareTitle)).Append("\">\n");
        html.Append("<meta name=\"twitter:description\" content=\"").Append(e(description)).Append("\">\n");
        html.Append("<meta name=\"twitter:image\" content=\"").Append(Origin).Append("/og.png\">\n");
        return html.ToString();
    }

    private static string Summary(Poll poll)
    {
        if (string.IsNullOrWhiteSpace(poll.Description))
            return "Vote on dates for " + poll.Title + ". Mark yes or no on each date, no sign-up needed.";

        // Previews show one short paragraph, so line breaks collapse and long text is cut.
        var text = Regex.Replace(poll.Description, @"\s+", " ").Trim();
        const int max = 160;
        if (text.Length <= max) return text;

        var cut = text.LastIndexOf(' ', max);
        if (cut < max / 2) cut = max;
        // Never split a surrogate pair, which would leave half an emoji in the tag.
        if (char.IsHighSurrogate(text[cut - 1])) cut--;
        return text[..cut].TrimEnd() + "...";
    }
}
