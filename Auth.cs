using System.Security.Cryptography;
using System.Text;
using MongoDB.Bson;
using MongoDB.Bson.Serialization.Attributes;
using MongoDB.Driver;

namespace DraftPoll;

[BsonIgnoreExtraElements]
public sealed class User
{
    [BsonId]
    public ObjectId MongoId { get; set; }

    /// <summary>Lower cased, and the only identity this app holds. Unique index.</summary>
    public string Email { get; set; } = "";

    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
    public DateTime LastSeenUtc { get; set; } = DateTime.UtcNow;
}

/// <summary>
/// A sign in link, and a session, both stored as SHA-256 hashes rather than as the value handed to
/// the browser. A dump of this collection therefore grants nobody a session.
/// </summary>
[BsonIgnoreExtraElements]
public sealed class AuthToken
{
    [BsonId]
    public ObjectId MongoId { get; set; }

    public string Hash { get; set; } = "";
    public string Email { get; set; } = "";

    /// <summary>"login" for a one time sign in link, "session" for a signed in browser.</summary>
    public string Kind { get; set; } = "login";

    public DateTime ExpiresUtc { get; set; }
    public DateTime CreatedUtc { get; set; } = DateTime.UtcNow;
}

public sealed record SignInRequest(string? Email);
public sealed record ClaimRequest(List<string>? AdminIds);

public sealed class AuthStore
{
    public const string CookieName = "sid";
    private static readonly TimeSpan LoginLifetime = TimeSpan.FromMinutes(15);
    private static readonly TimeSpan SessionLifetime = TimeSpan.FromDays(30);

    private readonly IMongoCollection<User> _users;
    private readonly IMongoCollection<AuthToken> _tokens;

    public AuthStore(IMongoClient client, IConfiguration config)
    {
        var db = client.GetDatabase(config["Mongo:Database"] ?? "draftpoll");
        _users = db.GetCollection<User>("users");
        _tokens = db.GetCollection<AuthToken>("authtokens");

        _users.Indexes.CreateOne(new CreateIndexModel<User>(
            Builders<User>.IndexKeys.Ascending(u => u.Email),
            new CreateIndexOptions { Unique = true, Name = "ux_email" }));

        _tokens.Indexes.CreateMany(new[]
        {
            new CreateIndexModel<AuthToken>(
                Builders<AuthToken>.IndexKeys.Ascending(t => t.Hash),
                new CreateIndexOptions { Unique = true, Name = "ux_hash" }),
            // Mongo removes expired links and sessions on its own, so nothing accumulates.
            new CreateIndexModel<AuthToken>(
                Builders<AuthToken>.IndexKeys.Ascending(t => t.ExpiresUtc),
                new CreateIndexOptions { ExpireAfter = TimeSpan.Zero, Name = "ttl_expires" })
        });
    }

    private static string Hash(string value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));

    /// <summary>Normalised email, or null when it does not look like an address at all.</summary>
    public static string? CleanEmail(string? raw)
    {
        var value = raw?.Trim().ToLowerInvariant();
        if (string.IsNullOrEmpty(value) || value.Length > 200) return null;

        var at = value.IndexOf('@');
        if (at <= 0 || at == value.Length - 1) return null;
        if (value.IndexOf('@', at + 1) != -1) return null;
        if (!value[(at + 1)..].Contains('.')) return null;
        if (value.Contains(' ')) return null;
        return value;
    }

    /// <summary>Issues a one time sign in token and returns the raw value for the email.</summary>
    public async Task<string> CreateLoginTokenAsync(string email)
    {
        var raw = Id.New(40);
        await _tokens.InsertOneAsync(new AuthToken
        {
            Hash = Hash(raw),
            Email = email,
            Kind = "login",
            ExpiresUtc = DateTime.UtcNow.Add(LoginLifetime)
        });
        return raw;
    }

    /// <summary>
    /// Consumes a sign in token and returns a session token, or null when the link is unknown,
    /// expired or already used. The delete is what makes it single use.
    /// </summary>
    public async Task<string?> RedeemLoginTokenAsync(string raw)
    {
        var found = await _tokens.FindOneAndDeleteAsync(t =>
            t.Hash == Hash(raw) && t.Kind == "login" && t.ExpiresUtc > DateTime.UtcNow);
        if (found is null) return null;

        await _users.UpdateOneAsync(
            u => u.Email == found.Email,
            Builders<User>.Update
                .SetOnInsert(u => u.Email, found.Email)
                .SetOnInsert(u => u.CreatedUtc, DateTime.UtcNow)
                .Set(u => u.LastSeenUtc, DateTime.UtcNow),
            new UpdateOptions { IsUpsert = true });

        var session = Id.New(40);
        await _tokens.InsertOneAsync(new AuthToken
        {
            Hash = Hash(session),
            Email = found.Email,
            Kind = "session",
            ExpiresUtc = DateTime.UtcNow.Add(SessionLifetime)
        });
        return session;
    }

    /// <summary>The signed in email for a session cookie, or null.</summary>
    public async Task<string?> EmailForSessionAsync(string? raw)
    {
        if (string.IsNullOrEmpty(raw)) return null;
        var token = await _tokens
            .Find(t => t.Hash == Hash(raw) && t.Kind == "session" && t.ExpiresUtc > DateTime.UtcNow)
            .FirstOrDefaultAsync();
        return token?.Email;
    }

    public Task SignOutAsync(string? raw) =>
        string.IsNullOrEmpty(raw) ? Task.CompletedTask : _tokens.DeleteOneAsync(t => t.Hash == Hash(raw));

    /// <summary>Removes every session for an address, used when signing out everywhere.</summary>
    public Task SignOutEverywhereAsync(string email) =>
        _tokens.DeleteManyAsync(t => t.Email == email && t.Kind == "session");
}
