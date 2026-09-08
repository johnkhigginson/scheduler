using System.Security.Cryptography;
using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;

namespace DraftPoll;

public static class Id
{
    private const string Alphabet = "23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";

    public static string New(int length = 12)
    {
        var chars = new char[length];
        Span<byte> buffer = stackalloc byte[length];
        RandomNumberGenerator.Fill(buffer);
        for (var i = 0; i < length; i++)
        {
            chars[i] = Alphabet[buffer[i] % Alphabet.Length];
        }
        return new string(chars);
    }
}

[BsonIgnoreExtraElements]
public sealed class Poll
{
    [BsonId]
    public ObjectId MongoId { get; set; }

    /// <summary>Shareable id. Anyone with this can view and vote.</summary>
    public string PublicId { get; set; } = "";

    /// <summary>Secret id. Grants edit and delete on the whole poll.</summary>
    public string AdminId { get; set; } = "";

    /// <summary>
    /// The signed in account that owns this poll, if there was one. Anonymous polls have none and
    /// keep working exactly as before, which is the whole point of the product.
    /// </summary>
    public string? OwnerEmail { get; set; }

    public string Title { get; set; } = "";
    public string? Description { get; set; }
    public string? OrganizerName { get; set; }
    public bool Closed { get; set; }

    /// <summary>
    /// Whether voters get a maybe option at all. Off by default: a yes or no answer is what most
    /// organizers actually want, and maybe makes the tally harder to read.
    /// </summary>
    public bool AllowMaybe { get; set; }

    /// <summary>
    /// IANA zone the organizer was in when they created the poll, for example America/Denver.
    /// Option times are naive wall clock strings, so this is the only thing that says which wall
    /// clock they refer to. Display only, never used to shift a date.
    /// </summary>
    public string? TimeZone { get; set; }

    /// <summary>
    /// When voting closes on its own. This is a real instant so it is a UTC DateTime, unlike the
    /// date options, which stay strings precisely so they never move between timezones.
    /// </summary>
    public DateTime? DeadlineUtc { get; set; }

    public List<PollOption> Options { get; set; } = new();
    public List<Participant> Participants { get; set; } = new();
    public List<Comment> Comments { get; set; } = new();

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
}

[BsonIgnoreExtraElements]
public sealed class PollOption
{
    public string Id { get; set; } = "";

    /// <summary>ISO date, yyyy-MM-dd. Stored as a string on purpose so no timezone shifting happens.</summary>
    public string Date { get; set; } = "";

    /// <summary>Optional 24h time, HH:mm.</summary>
    public string? Time { get; set; }
}

[BsonIgnoreExtraElements]
public sealed class Participant
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";

    /// <summary>Secret returned once at creation. Lets that person edit or delete their own row later.</summary>
    public string EditToken { get; set; } = "";

    /// <summary>Keyed by option id. Values: yes, maybe, no.</summary>
    public Dictionary<string, string> Votes { get; set; } = new();

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedUtc { get; set; } = DateTime.UtcNow;
}

[BsonIgnoreExtraElements]
public sealed class Comment
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Text { get; set; } = "";
    public string EditToken { get; set; } = "";
    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
}

// Request payloads

public sealed record OptionInput(string? Date, string? Time);

public sealed record CreatePollRequest(
    string? Title,
    string? Description,
    string? OrganizerName,
    List<OptionInput>? Options,
    string? TimeZone,
    string? Deadline,
    bool? AllowMaybe);

public sealed record ParticipantRequest(string? Name, Dictionary<string, string>? Votes);

public sealed record CommentRequest(string? Name, string? Text);

/// <summary>An empty string for Deadline removes the deadline. Null leaves it alone.</summary>
public sealed record UpdatePollRequest(
    string? Title, string? Description, bool? Closed, string? Deadline, bool? AllowMaybe);

/// <summary>Dates the organizer wants to add to a poll that already exists.</summary>
public sealed record AddOptionsRequest(List<OptionInput>? Options);

public sealed record CommentEditRequest(string? Text);
