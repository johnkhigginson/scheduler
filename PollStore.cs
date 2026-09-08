using MongoDB.Bson;
using MongoDB.Driver;

namespace DraftPoll;

public sealed class PollStore
{
    private readonly IMongoCollection<Poll> _polls;

    public PollStore(IMongoClient client, IConfiguration config)
    {
        var dbName = config["Mongo:Database"] ?? "draftpoll";
        _polls = client.GetDatabase(dbName).GetCollection<Poll>("polls");

        _polls.Indexes.CreateMany(new[]
        {
            new CreateIndexModel<Poll>(
                Builders<Poll>.IndexKeys.Ascending(p => p.PublicId),
                new CreateIndexOptions { Unique = true, Name = "ux_publicId" }),
            new CreateIndexModel<Poll>(
                Builders<Poll>.IndexKeys.Ascending(p => p.AdminId),
                new CreateIndexOptions { Unique = true, Name = "ux_adminId" })
        });
    }

    private static readonly FilterDefinitionBuilder<Poll> F = Builders<Poll>.Filter;
    private static readonly UpdateDefinitionBuilder<Poll> U = Builders<Poll>.Update;

    private static FilterDefinition<Poll> ByPublic(string publicId) => F.Eq(p => p.PublicId, publicId);

    /// <summary>
    /// Open to voters: not closed by hand and not past its deadline. Evaluated by the server at
    /// write time rather than trusted from a poll read moments earlier, so a vote cannot land just
    /// after the deadline because the request was already in flight. Polls saved before deadlines
    /// existed have no DeadlineUtc field at all, which the null comparison matches.
    /// </summary>
    private static FilterDefinition<Poll> Open() =>
        F.Eq(p => p.Closed, false) &
        F.Or(F.Eq(p => p.DeadlineUtc, null), F.Gt(p => p.DeadlineUtc, DateTime.UtcNow));

    /// <summary>
    /// Refuses the write once an embedded array is at its cap. This lives in the filter rather than
    /// in a separate count check so two simultaneous writes cannot both read "one slot left" and
    /// then both take it.
    /// </summary>
    private static FilterDefinition<Poll> UnderCap(string field, int cap) =>
        new BsonDocumentFilterDefinition<Poll>(new BsonDocument("$expr",
            new BsonDocument("$lt", new BsonArray
            {
                new BsonDocument("$size", new BsonDocument("$ifNull", new BsonArray { "$" + field, new BsonArray() })),
                cap
            })));

    public Task InsertAsync(Poll poll) => _polls.InsertOneAsync(poll);

    public Task<Poll?> GetByPublicIdAsync(string publicId) =>
        _polls.Find(ByPublic(publicId)).FirstOrDefaultAsync()!;

    public Task<Poll?> GetByAdminIdAsync(string adminId) =>
        _polls.Find(p => p.AdminId == adminId).FirstOrDefaultAsync()!;

    public Task DeleteAsync(string adminId) =>
        _polls.DeleteOneAsync(p => p.AdminId == adminId);

    /// <summary>Site admin only. Deletes by the public id, since that is what the admin area lists.</summary>
    public Task DeleteByPublicIdAsync(string publicId) =>
        _polls.DeleteOneAsync(p => p.PublicId == publicId);

    public Task<long> CountAsync() => _polls.CountDocumentsAsync(new BsonDocument());

    /// <summary>Polls belonging to one signed in account, newest first.</summary>
    public Task<List<Poll>> ListForOwnerAsync(string email) =>
        _polls.Find(p => p.OwnerEmail == email)
              .SortByDescending(p => p.CreatedUtc)
              .Limit(200)
              .ToListAsync();

    /// <summary>
    /// Attaches polls to an account by their organizer tokens. This is how a poll made before
    /// signing in becomes visible on the account, using proof the browser already holds.
    /// </summary>
    public async Task<long> ClaimAsync(IEnumerable<string> adminIds, string email)
    {
        var ids = adminIds.Where(id => !string.IsNullOrWhiteSpace(id)).Take(200).ToList();
        if (ids.Count == 0) return 0;

        var result = await _polls.UpdateManyAsync(
            Builders<Poll>.Filter.In(p => p.AdminId, ids) &
            Builders<Poll>.Filter.Eq(p => p.OwnerEmail, null),
            U.Set(p => p.OwnerEmail, email));
        return result.ModifiedCount;
    }

    /// <summary>Newest first, capped, for the admin overview.</summary>
    public Task<List<Poll>> ListRecentAsync(int limit) =>
        _polls.Find(new BsonDocument())
              .SortByDescending(p => p.CreatedUtc)
              .Limit(limit)
              .ToListAsync();

    /*
      Everything below writes with a targeted operator rather than replacing the document.
      A whole document replace loses concurrent edits: two people voting in the same second both
      read the poll, both write their own copy back, and the first write disappears silently.
      Push, pull and positional set each touch only the field they own, so concurrent writers no
      longer overwrite each other.
    */

    /// <summary>Appends a row. Returns false if the poll is gone, closed, or already full.</summary>
    public async Task<bool> AddParticipantAsync(string publicId, Participant participant, bool requireOpen, int cap)
    {
        var filter = ByPublic(publicId) & UnderCap(nameof(Poll.Participants), cap);
        if (requireOpen) filter &= Open();

        var result = await _polls.UpdateOneAsync(filter, U.Push(p => p.Participants, participant));
        return result.MatchedCount == 1;
    }

    /// <summary>Edits one row in place. Returns false if the poll is gone, closed, or the row vanished.</summary>
    public async Task<bool> UpdateParticipantAsync(
        string publicId, string participantId, string? name, Dictionary<string, string> votes, bool requireOpen)
    {
        // The positional $ targets the element the ElemMatch above selected. Do not hand write the
        // array path instead: the driver maps a member called Id onto _id even inside embedded
        // documents, so a literal "Participants.$[row].Id" filter silently matches nothing and the
        // update becomes a no-op that still reports success.
        var filter = ByPublic(publicId) & F.ElemMatch(p => p.Participants, x => x.Id == participantId);
        if (requireOpen) filter &= Open();

        var update = U.Set("Participants.$.Votes", votes)
                      .Set("Participants.$.UpdatedUtc", DateTime.UtcNow);
        if (name is not null) update = update.Set("Participants.$.Name", name);

        var result = await _polls.UpdateOneAsync(filter, update);
        return result.MatchedCount == 1;
    }

    public async Task<bool> RemoveParticipantAsync(string publicId, string participantId)
    {
        var result = await _polls.UpdateOneAsync(
            ByPublic(publicId),
            U.PullFilter(p => p.Participants, Builders<Participant>.Filter.Eq(x => x.Id, participantId)));
        return result.MatchedCount == 1;
    }

    /// <summary>Appends a comment. Returns false if the poll is gone or the comment cap is reached.</summary>
    public async Task<bool> AddCommentAsync(string publicId, Comment comment, int cap)
    {
        var result = await _polls.UpdateOneAsync(
            ByPublic(publicId) & UnderCap(nameof(Poll.Comments), cap),
            U.Push(p => p.Comments, comment));
        return result.MatchedCount == 1;
    }

    public async Task<bool> RemoveCommentAsync(string publicId, string commentId)
    {
        var result = await _polls.UpdateOneAsync(
            ByPublic(publicId),
            U.PullFilter(p => p.Comments, Builders<Comment>.Filter.Eq(x => x.Id, commentId)));
        return result.MatchedCount == 1;
    }

    /// <summary>
    /// Appends new date options and re-sorts the whole array by date then time. Without the sort a
    /// date added later sat at the end, so the results grid drew the same day as two separate
    /// header groups and the vote editor showed two cards for one day. Mongo applies $sort to the
    /// entire array after the push, which is exactly what is wanted here.
    /// </summary>
    public async Task<bool> AddOptionsAsync(string publicId, List<PollOption> options, int cap)
    {
        var result = await _polls.UpdateOneAsync(
            ByPublic(publicId) & UnderCap(nameof(Poll.Options), cap - options.Count + 1),
            U.PushEach(p => p.Options, options,
                sort: Builders<PollOption>.Sort.Ascending(o => o.Date).Ascending(o => o.Time)));
        return result.MatchedCount == 1;
    }

    /// <summary>
    /// Removes an option and every vote cast on it. The votes have to go in the same update,
    /// otherwise each participant keeps a stale key for a date that no longer exists.
    /// </summary>
    public async Task<bool> RemoveOptionAsync(string publicId, string optionId)
    {
        var update = U.PullFilter(p => p.Options, Builders<PollOption>.Filter.Eq(o => o.Id, optionId))
                      .Unset("Participants.$[].Votes." + optionId);

        var result = await _polls.UpdateOneAsync(ByPublic(publicId), update);
        return result.MatchedCount == 1;
    }

    public async Task<bool> UpdateCommentAsync(string publicId, string commentId, string text)
    {
        var result = await _polls.UpdateOneAsync(
            ByPublic(publicId) & F.ElemMatch(p => p.Comments, c => c.Id == commentId),
            U.Set("Comments.$.Text", text));
        return result.MatchedCount == 1;
    }

    /// <summary>Admin edit of the poll itself. Only the supplied fields are written.</summary>
    public async Task<bool> UpdatePollAsync(
        string publicId, string? title, string? description, bool descriptionSupplied,
        bool? closed, DateTime? deadline, bool deadlineSupplied, bool? allowMaybe)
    {
        var sets = new List<UpdateDefinition<Poll>>();
        if (title is not null) sets.Add(U.Set(p => p.Title, title));
        if (descriptionSupplied) sets.Add(U.Set(p => p.Description, description));
        if (closed.HasValue) sets.Add(U.Set(p => p.Closed, closed.Value));
        if (allowMaybe.HasValue) sets.Add(U.Set(p => p.AllowMaybe, allowMaybe.Value));
        // A supplied but empty deadline clears it, which is how the organizer removes one.
        if (deadlineSupplied) sets.Add(U.Set(p => p.DeadlineUtc, deadline));
        if (sets.Count == 0) return true;

        var result = await _polls.UpdateOneAsync(ByPublic(publicId), U.Combine(sets));
        return result.MatchedCount == 1;
    }
}
