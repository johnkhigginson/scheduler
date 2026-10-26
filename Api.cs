using System.Security.Cryptography;
using System.Text;

namespace DraftPoll;

/// <summary>Rate limit policy names and the per client partition key.</summary>
public static class RateLimits
{
    public const string Writes = "writes";
    public const string Create = "create";
    public const string SignIn = "signin";
    public const string EmailLinks = "emaillinks";

    /// <summary>
    /// Partition key for the limiters. This is the real caller only because UseForwardedHeaders
    /// runs first, otherwise every request partitions to the proxy address and one visitor can
    /// exhaust the window for everybody.
    /// </summary>
    public static string ClientKey(HttpContext ctx) =>
        ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";
}

/// <summary>Shared validation, auth and response shaping helpers.</summary>
public static class Api
{
    /// <summary>
    /// Storage is nowhere near the binding constraint here: 300 options across 60 participants is
    /// roughly 270 KB against Mongo's 16 MB document limit. The old ceiling of 60 was really about
    /// the results grid being unreadable, which is a display problem and is handled in the client
    /// by grouping columns under each day.
    /// </summary>
    public const int MaxOptions = 300;
    public const int MaxParticipants = 60;
    public const int MaxComments = 300;

    private static readonly string[] ValidVotes = { "yes", "maybe", "no" };

    public static string? Clean(string? value, int maxLength)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        value = value.Trim();
        return value.Length > maxLength ? value[..maxLength] : value;
    }

    /// <summary>True once the deadline has passed. A poll with no deadline never expires.</summary>
    public static bool IsExpired(Poll poll) =>
        poll.DeadlineUtc.HasValue && DateTime.UtcNow >= poll.DeadlineUtc.Value;

    /// <summary>
    /// Closed to voters, whether the organizer closed it by hand or the deadline ran out. Always
    /// use this rather than Poll.Closed, otherwise an expired poll still accepts votes.
    /// </summary>
    public static bool IsClosed(Poll poll) => poll.Closed || IsExpired(poll);

    /// <summary>Accepts an IANA zone id and returns null for anything unrecognised.</summary>
    public static string? CleanTimeZone(string? value)
    {
        var id = Clean(value, 64);
        if (id is null) return null;
        return TimeZoneInfo.TryFindSystemTimeZoneById(id, out _) ? id : null;
    }

    /// <summary>
    /// Parses an ISO 8601 instant into UTC. Returns null when the value is missing or unparseable,
    /// so a malformed deadline never silently becomes "closed right now".
    /// </summary>
    public static DateTime? ParseDeadline(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        return DateTimeOffset.TryParse(value, System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.RoundtripKind, out var parsed)
            ? parsed.UtcDateTime
            : null;
    }

    /// <summary>
    /// The site wide admin key, read once at startup. Null or empty disables the admin area
    /// entirely rather than leaving it open, because this key can read every poll on the server
    /// including organizer tokens.
    /// </summary>
    public static string? SiteAdminKey { get; set; }

    public static bool IsSiteAdmin(HttpContext ctx) =>
        !string.IsNullOrEmpty(SiteAdminKey)
        && ctx.Request.Headers.TryGetValue("X-Site-Key", out var key)
        && FixedTimeEquals(key.ToString(), SiteAdminKey!);

    public static bool IsAdmin(HttpContext ctx, Poll poll) =>
        ctx.Request.Headers.TryGetValue("X-Admin-Token", out var token)
        && IsAdminToken(token.ToString(), poll);

    /// <summary>For the one route that carries the organizer token in a request body.</summary>
    public static bool IsAdminToken(string? token, Poll poll) =>
        !string.IsNullOrEmpty(token)
        && !string.IsNullOrEmpty(poll.AdminId)
        && FixedTimeEquals(token, poll.AdminId);

    public static bool HasEditToken(HttpContext ctx, string expected) =>
        ctx.Request.Headers.TryGetValue("X-Edit-Token", out var token)
        && !string.IsNullOrEmpty(expected)
        && FixedTimeEquals(token.ToString(), expected);

    /// <summary>Constant time compare, padded so length never leaks through timing.</summary>
    private static bool FixedTimeEquals(string a, string b)
    {
        const int width = 96;
        if (a.Length > width || b.Length > width) return false;
        return CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(a.PadRight(width)),
            Encoding.UTF8.GetBytes(b.PadRight(width)));
    }

    /// <summary>Public view of a poll. Never includes adminId or any edit token.</summary>
    public static object Shape(Poll poll, bool isAdmin) => new
    {
        publicId = poll.PublicId,
        title = poll.Title,
        description = poll.Description,
        organizerName = poll.OrganizerName,
        // Effective state, so a client never has to work out expiry for itself.
        closed = IsClosed(poll),
        closedByDeadline = IsExpired(poll),
        timeZone = poll.TimeZone,
        deadlineUtc = poll.DeadlineUtc,
        allowMaybe = poll.AllowMaybe,
        isAdmin,
        createdUtc = poll.CreatedUtc,
        options = poll.Options
            .Select(o => new { id = o.Id, date = o.Date, time = o.Time })
            .ToList(),
        participants = poll.Participants
            .OrderBy(p => p.CreatedUtc)
            .Select(p => new { id = p.Id, name = p.Name, votes = p.Votes, updatedUtc = p.UpdatedUtc })
            .ToList(),
        comments = poll.Comments
            .OrderBy(c => c.CreatedUtc)
            .Select(c => new { id = c.Id, name = c.Name, text = c.Text, createdUtc = c.CreatedUtc })
            .ToList()
    };

    /// <summary>
    /// Drops unknown option ids and anything that is not yes, maybe or no. Also drops maybe on a
    /// poll that did not enable it, so a hand crafted request cannot introduce an answer the
    /// organizer chose not to offer.
    /// </summary>
    public static Dictionary<string, string> SanitizeVotes(Dictionary<string, string>? votes, Poll poll)
    {
        var result = new Dictionary<string, string>();
        if (votes is null) return result;

        var validOptionIds = poll.Options.Select(o => o.Id).ToHashSet(StringComparer.Ordinal);
        foreach (var (optionId, rawValue) in votes)
        {
            if (!validOptionIds.Contains(optionId)) continue;
            var value = rawValue?.ToLowerInvariant();
            if (value is null || !ValidVotes.Contains(value)) continue;
            if (value == "maybe" && !poll.AllowMaybe) continue;
            result[optionId] = value;
        }
        return result;
    }

    /// <summary>Parses and de-dupes the submitted date and time options.</summary>
    public static List<PollOption> BuildOptions(IEnumerable<OptionInput>? inputs)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var options = new List<PollOption>();

        foreach (var input in inputs ?? Enumerable.Empty<OptionInput>())
        {
            var rawDate = Clean(input.Date, 10);
            if (rawDate is null || !DateOnly.TryParse(rawDate, out var date)) continue;

            var time = Clean(input.Time, 5);
            if (time is not null && !TimeOnly.TryParse(time, out _)) time = null;

            if (!seen.Add($"{date:yyyy-MM-dd}|{time}")) continue;

            options.Add(new PollOption
            {
                Id = Id.New(6),
                Date = date.ToString("yyyy-MM-dd"),
                Time = time
            });

            if (options.Count >= MaxOptions) break;
        }

        return options
            .OrderBy(o => o.Date, StringComparer.Ordinal)
            .ThenBy(o => o.Time ?? "", StringComparer.Ordinal)
            .ToList();
    }
}
