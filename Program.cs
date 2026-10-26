using System.Net;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.RateLimiting;
using DraftPoll;
using Microsoft.AspNetCore.Http.Json;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.RateLimiting;
using MongoDB.Bson;
using MongoDB.Driver;

var builder = WebApplication.CreateBuilder(args);

// The app only ever listens on loopback behind a reverse proxy, so without this every request
// looks like it came from 127.0.0.1 and the per IP rate limiter would throttle everyone as one
// client. KnownProxies has to name the IPv4 loopback explicitly, the default only covers ::1.
builder.Services.Configure<ForwardedHeadersOptions>(o =>
{
    o.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    o.KnownProxies.Clear();
    o.KnownProxies.Add(IPAddress.Loopback);
    o.KnownProxies.Add(IPAddress.IPv6Loopback);
});

builder.Services.AddSingleton<IMongoClient>(_ =>
{
    var connectionString = builder.Configuration.GetConnectionString("Mongo")
                           ?? Environment.GetEnvironmentVariable("MONGO_URL")
                           ?? "mongodb://localhost:27017";
    return new MongoClient(connectionString);
});
builder.Services.AddSingleton<PollStore>();
builder.Services.AddSingleton<AuthStore>();
builder.Services.AddHttpClient<Mailer>();
builder.Services.Configure<JsonOptions>(o =>
{
    o.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    o.SerializerOptions.DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull;
});

// Reads stay unmetered. A poll page is meant to be refreshed and shared freely, and the whole
// document is one read. Only the endpoints that write to Mongo are capped.
builder.Services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

    // Voting is bursty. Someone filling in twelve dates and correcting a few is well inside this.
    o.AddPolicy(RateLimits.Writes, ctx => RateLimitPartition.GetFixedWindowLimiter(
        RateLimits.ClientKey(ctx),
        _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = 30,
            Window = TimeSpan.FromMinutes(1),
            QueueLimit = 0
        }));

    // Poll creation is the expensive one, it makes a new document every time and needs no token.
    o.AddPolicy(RateLimits.Create, ctx => RateLimitPartition.GetFixedWindowLimiter(
        RateLimits.ClientKey(ctx),
        _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = 10,
            Window = TimeSpan.FromHours(1),
            QueueLimit = 0
        }));

    // Sign in links send real email to an address the caller chose, so this is far tighter than the
    // ordinary writes. It caps how much mail one address or one host can cause.
    o.AddPolicy(RateLimits.SignIn, ctx => RateLimitPartition.GetFixedWindowLimiter(
        RateLimits.ClientKey(ctx),
        _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = 6,
            Window = TimeSpan.FromHours(1),
            QueueLimit = 0
        }));

    // Same reasoning as sign in: it mails an address the caller chose. It also needs the organizer
    // token of a real poll, so a legitimate organizer never gets near five an hour.
    o.AddPolicy(RateLimits.EmailLinks, ctx => RateLimitPartition.GetFixedWindowLimiter(
        RateLimits.ClientKey(ctx),
        _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = 5,
            Window = TimeSpan.FromHours(1),
            QueueLimit = 0
        }));

    o.OnRejected = async (ctx, token) =>
    {
        if (ctx.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
            ctx.HttpContext.Response.Headers.RetryAfter = ((int)retryAfter.TotalSeconds).ToString();

        await ctx.HttpContext.Response.WriteAsJsonAsync(
            new { error = "Too many requests. Wait a moment and try again." }, token);
    };
});

var app = builder.Build();

// Read once at startup. An unset key leaves the admin area switched off rather than open, because
// this one key can read every poll on the server.
Api.SiteAdminKey = builder.Configuration["Admin:Key"];

// Must run before the rate limiter so the limiter partitions on the real client address.
app.UseForwardedHeaders();

app.UseDefaultFiles();
app.UseStaticFiles();
// Routing runs after static files on purpose. Left implicit it runs first, and the catch all 404
// page below would then claim "/" and every real file before the static file middleware saw them.
app.UseRouting();
app.UseRateLimiter();

Task SendPage(HttpContext ctx, string file)
{
    ctx.Response.ContentType = "text/html; charset=utf-8";
    return ctx.Response.SendFileAsync(Path.Combine(app.Environment.WebRootPath, file));
}

// Pretty poll URL. The id is parsed client side from the path; the server only fills in the title
// and link preview tags, so a shared link unfurls with the poll's own name.
var pollPage = Site.LoadPollPage(Path.Combine(app.Environment.WebRootPath, "poll.html"));
app.MapGet("/p/{publicId}", async (string publicId, PollStore store) =>
{
    // An unknown id still gets the page, with generic tags. The script then says the poll is gone.
    var poll = await store.GetShareInfoAsync(publicId);
    return Results.Content(pollPage.Head + Site.ShareTags(poll) + pollPage.Tail, "text/html; charset=utf-8");
});

// Static pages at clean URLs. Each is also reachable as its .html file, which is harmless because
// every indexable page names its canonical URL.
foreach (var page in new[]
{
    "privacy", "terms", "doodle-alternative", "when2meet-alternative", "framadate-alternative"
})
    app.MapGet("/" + page, (HttpContext ctx) => SendPage(ctx, page + ".html"));

// Deploy health check. Returns 503 if Mongo is unreachable, so a bad deploy fails loudly.
app.MapGet("/healthz", async (IMongoClient client) =>
{
    try
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        await client.GetDatabase("admin")
            .RunCommandAsync<BsonDocument>(new BsonDocument("ping", 1), cancellationToken: cts.Token);
        return Results.Ok(new { status = "ok" });
    }
    catch
    {
        return Results.Json(new { status = "mongo unreachable" }, statusCode: 503);
    }
});

// Admin area. The page itself is public, but it holds nothing until a valid key is supplied, and
// every route below refuses without one.
app.MapGet("/admin", (HttpContext ctx) => SendPage(ctx, "admin.html"));

var site = app.MapGroup("/api/site");

site.MapGet("/overview", async (HttpContext ctx, PollStore store) =>
{
    if (!Api.IsSiteAdmin(ctx)) return Results.StatusCode(StatusCodes.Status403Forbidden);

    var polls = await store.ListRecentAsync(500);
    return Results.Ok(new
    {
        total = await store.CountAsync(),
        polls = polls.Select(p => new
        {
            publicId = p.PublicId,
            title = p.Title,
            organizerName = p.OrganizerName,
            createdUtc = p.CreatedUtc,
            closed = Api.IsClosed(p),
            closedByDeadline = Api.IsExpired(p),
            deadlineUtc = p.DeadlineUtc,
            allowMaybe = p.AllowMaybe,
            timeZone = p.TimeZone,
            options = p.Options.Count,
            participants = p.Participants.Count,
            comments = p.Comments.Count,
            answers = p.Participants.Sum(x => x.Votes.Count)
        })
    });
}).RequireRateLimiting(RateLimits.Writes);

site.MapGet("/polls/{publicId}", async (string publicId, HttpContext ctx, PollStore store) =>
{
    if (!Api.IsSiteAdmin(ctx)) return Results.StatusCode(StatusCodes.Status403Forbidden);

    var poll = await store.GetByPublicIdAsync(publicId);
    if (poll is null) return Results.NotFound();

    return Results.Ok(new
    {
        publicId = poll.PublicId,
        // Deliberately included. The organizer link cannot be recovered any other way, and being
        // able to hand it back is most of the point of having an admin area at all.
        adminId = poll.AdminId,
        title = poll.Title,
        description = poll.Description,
        organizerName = poll.OrganizerName,
        createdUtc = poll.CreatedUtc,
        closed = Api.IsClosed(poll),
        deadlineUtc = poll.DeadlineUtc,
        allowMaybe = poll.AllowMaybe,
        timeZone = poll.TimeZone,
        options = poll.Options.Select(o => new { id = o.Id, date = o.Date, time = o.Time }),
        participants = poll.Participants
            .OrderBy(p => p.CreatedUtc)
            .Select(p => new { id = p.Id, name = p.Name, votes = p.Votes, createdUtc = p.CreatedUtc, updatedUtc = p.UpdatedUtc }),
        comments = poll.Comments
            .OrderBy(c => c.CreatedUtc)
            .Select(c => new { id = c.Id, name = c.Name, text = c.Text, createdUtc = c.CreatedUtc })
    });
}).RequireRateLimiting(RateLimits.Writes);

site.MapDelete("/polls/{publicId}", async (string publicId, HttpContext ctx, PollStore store) =>
{
    if (!Api.IsSiteAdmin(ctx)) return Results.StatusCode(StatusCodes.Status403Forbidden);
    await store.DeleteByPublicIdAsync(publicId);
    return Results.Ok(new { ok = true });
}).RequireRateLimiting(RateLimits.Writes);

// ---------- accounts ----------
// Optional throughout. A poll made without signing in behaves exactly as it always has; an account
// only adds a list of the polls you made.

app.MapGet("/signin", (HttpContext ctx) => SendPage(ctx, "signin.html"));

app.MapGet("/my", (HttpContext ctx) => SendPage(ctx, "my.html"));

var auth = app.MapGroup("/api/auth");

auth.MapPost("/request", async (SignInRequest req, HttpContext ctx, AuthStore store, Mailer mailer) =>
{
    var email = AuthStore.CleanEmail(req.Email);
    if (email is null) return Results.BadRequest(new { error = "That does not look like an email address." });

    var token = await store.CreateLoginTokenAsync(email);
    var link = $"{ctx.Request.Scheme}://{ctx.Request.Host}/auth/verify?t={token}";
    var sent = await mailer.SendSignInLinkAsync(email, link);

    // The same answer either way, so this cannot be used to find out who has an account.
    return Results.Ok(new { sent });
}).RequireRateLimiting(RateLimits.SignIn);

app.MapGet("/auth/verify", async (string? t, HttpContext ctx, AuthStore store) =>
{
    var session = string.IsNullOrEmpty(t) ? null : await store.RedeemLoginTokenAsync(t);
    if (session is null) return Results.Redirect("/signin?expired=1");

    ctx.Response.Cookies.Append(AuthStore.CookieName, session, new CookieOptions
    {
        HttpOnly = true,
        // Behind Caddy the app sees loopback http, so this relies on UseForwardedHeaders having
        // already restored the real scheme.
        Secure = ctx.Request.IsHttps,
        SameSite = SameSiteMode.Lax,
        Path = "/",
        Expires = DateTimeOffset.UtcNow.AddDays(30)
    });
    return Results.Redirect("/my");
});

auth.MapGet("/me", async (HttpContext ctx, AuthStore store) =>
{
    var email = await store.EmailForSessionAsync(ctx.Request.Cookies[AuthStore.CookieName]);
    return email is null ? Results.Ok(new { signedIn = false }) : Results.Ok(new { signedIn = true, email });
});

auth.MapPost("/signout", async (HttpContext ctx, AuthStore store) =>
{
    await store.SignOutAsync(ctx.Request.Cookies[AuthStore.CookieName]);
    ctx.Response.Cookies.Delete(AuthStore.CookieName, new CookieOptions { Path = "/" });
    return Results.Ok(new { ok = true });
});

auth.MapGet("/polls", async (HttpContext ctx, AuthStore store, PollStore polls) =>
{
    var email = await store.EmailForSessionAsync(ctx.Request.Cookies[AuthStore.CookieName]);
    if (email is null) return Results.StatusCode(StatusCodes.Status401Unauthorized);

    var mine = await polls.ListForOwnerAsync(email);
    return Results.Ok(new
    {
        email,
        polls = mine.Select(p => new
        {
            publicId = p.PublicId,
            adminId = p.AdminId,      // it is the owner's own poll, so hand back the way in
            title = p.Title,
            createdUtc = p.CreatedUtc,
            closed = Api.IsClosed(p),
            options = p.Options.Count,
            participants = p.Participants.Count
        })
    });
});

auth.MapPost("/claim", async (ClaimRequest req, HttpContext ctx, AuthStore store, PollStore polls) =>
{
    var email = await store.EmailForSessionAsync(ctx.Request.Cookies[AuthStore.CookieName]);
    if (email is null) return Results.StatusCode(StatusCodes.Status401Unauthorized);

    // Only polls whose organizer token this browser already holds, and only ones nobody owns yet.
    var claimed = await polls.ClaimAsync(req.AdminIds ?? new List<string>(), email);
    return Results.Ok(new { claimed });
}).RequireRateLimiting(RateLimits.Writes);

var api = app.MapGroup("/api");

// Create a poll. Returns the shareable id and the secret admin id.
api.MapPost("/polls", async (CreatePollRequest req, HttpContext ctx, PollStore store, AuthStore auth) =>
{
    var title = Api.Clean(req.Title, 120);
    if (title is null) return Results.BadRequest(new { error = "Give the poll a title." });

    var options = Api.BuildOptions(req.Options);
    if (options.Count == 0) return Results.BadRequest(new { error = "Add at least one valid date." });

    var poll = new Poll
    {
        PublicId = Id.New(14),
        AdminId = Id.New(24),
        Title = title,
        Description = Api.Clean(req.Description, 2000),
        OrganizerName = Api.Clean(req.OrganizerName, 60),
        Options = options,
        TimeZone = Api.CleanTimeZone(req.TimeZone),
        DeadlineUtc = Api.ParseDeadline(req.Deadline),
        AllowMaybe = req.AllowMaybe ?? false,
        // Null when nobody is signed in, which is the ordinary case and stays fully anonymous.
        OwnerEmail = await auth.EmailForSessionAsync(ctx.Request.Cookies[AuthStore.CookieName])
    };

    await store.InsertAsync(poll);
    return Results.Ok(new { publicId = poll.PublicId, adminId = poll.AdminId });
}).RequireRateLimiting(RateLimits.Create);

// Mail both links to the organizer. The address is used for this one send and never stored.
api.MapPost("/polls/{publicId}/email-links", async (
    string publicId, EmailLinksRequest req, HttpContext ctx, PollStore store, Mailer mailer) =>
{
    var poll = await store.GetByPublicIdAsync(publicId);
    if (poll is null) return Results.NotFound();
    if (!Api.IsAdminToken(req.AdminId, poll)) return Results.StatusCode(StatusCodes.Status403Forbidden);

    var email = AuthStore.CleanEmail(req.Email);
    if (email is null) return Results.BadRequest(new { error = "That does not look like an email address." });

    var publicUrl = $"{ctx.Request.Scheme}://{ctx.Request.Host}/p/{poll.PublicId}";
    var sent = await mailer.SendPollLinksAsync(email, poll.Title, publicUrl, publicUrl + "#a=" + poll.AdminId);

    // sent:false covers both a missing Postmark token and a refused send. Either way the page tells
    // the organizer to copy the links instead.
    return Results.Ok(new { sent });
}).RequireRateLimiting(RateLimits.EmailLinks);

// Read a poll.
api.MapGet("/polls/{publicId}", async (string publicId, HttpContext ctx, PollStore store) =>
{
    var poll = await store.GetByPublicIdAsync(publicId);
    return poll is null ? Results.NotFound() : Results.Ok(Api.Shape(poll, Api.IsAdmin(ctx, poll)));
});

// Resolve an admin token to its poll so the admin link can redirect.
api.MapGet("/admin/{adminId}", async (string adminId, PollStore store) =>
{
    var poll = await store.GetByAdminIdAsync(adminId);
    return poll is null ? Results.NotFound() : Results.Ok(new { publicId = poll.PublicId });
});

// Add a participant row. The edit token is returned once and only once.
api.MapPost("/polls/{publicId}/participants", async (
    string publicId, ParticipantRequest req, HttpContext ctx, PollStore store) =>
{
    var poll = await store.GetByPublicIdAsync(publicId);
    if (poll is null) return Results.NotFound();

    var isAdmin = Api.IsAdmin(ctx, poll);
    if (Api.IsClosed(poll) && !isAdmin)
        return Results.BadRequest(new { error = "This poll is closed." });
    if (poll.Participants.Count >= Api.MaxParticipants)
        return Results.BadRequest(new { error = "This poll is full." });

    var name = Api.Clean(req.Name, 60);
    if (name is null) return Results.BadRequest(new { error = "Enter your name." });

    var participant = new Participant
    {
        Id = Id.New(8),
        Name = name,
        EditToken = Id.New(24),
        Votes = Api.SanitizeVotes(req.Votes, poll)
    };

    // The checks above are on a copy that may already be stale. The append re-checks closed and
    // the row cap inside the update filter, which is what actually makes this safe under load.
    if (!await store.AddParticipantAsync(publicId, participant, !isAdmin, Api.MaxParticipants))
        return Results.BadRequest(new { error = "This poll is closed or full." });

    return Results.Ok(new { id = participant.Id, editToken = participant.EditToken });
}).RequireRateLimiting(RateLimits.Writes);

// Update a participant row. Needs that row's edit token, or the admin token.
api.MapPut("/polls/{publicId}/participants/{participantId}", async (
    string publicId, string participantId, ParticipantRequest req, HttpContext ctx, PollStore store) =>
{
    var poll = await store.GetByPublicIdAsync(publicId);
    if (poll is null) return Results.NotFound();

    var participant = poll.Participants.FirstOrDefault(p => p.Id == participantId);
    if (participant is null) return Results.NotFound();

    var isAdmin = Api.IsAdmin(ctx, poll);
    if (!isAdmin && !Api.HasEditToken(ctx, participant.EditToken))
        return Results.StatusCode(StatusCodes.Status403Forbidden);
    if (Api.IsClosed(poll) && !isAdmin)
        return Results.BadRequest(new { error = "This poll is closed." });

    // Writes only this row's fields, so a simultaneous edit to a different row is not clobbered.
    var updated = await store.UpdateParticipantAsync(
        publicId, participantId, Api.Clean(req.Name, 60), Api.SanitizeVotes(req.Votes, poll), !isAdmin);

    return updated ? Results.Ok(new { ok = true }) : Results.NotFound();
}).RequireRateLimiting(RateLimits.Writes);

// Delete a participant row.
api.MapDelete("/polls/{publicId}/participants/{participantId}", async (
    string publicId, string participantId, HttpContext ctx, PollStore store) =>
{
    var poll = await store.GetByPublicIdAsync(publicId);
    if (poll is null) return Results.NotFound();

    var participant = poll.Participants.FirstOrDefault(p => p.Id == participantId);
    if (participant is null) return Results.NotFound();

    if (!Api.IsAdmin(ctx, poll) && !Api.HasEditToken(ctx, participant.EditToken))
        return Results.StatusCode(StatusCodes.Status403Forbidden);

    await store.RemoveParticipantAsync(publicId, participantId);
    return Results.Ok(new { ok = true });
}).RequireRateLimiting(RateLimits.Writes);

// Add a comment.
api.MapPost("/polls/{publicId}/comments", async (
    string publicId, CommentRequest req, PollStore store) =>
{
    var poll = await store.GetByPublicIdAsync(publicId);
    if (poll is null) return Results.NotFound();
    if (poll.Comments.Count >= Api.MaxComments)
        return Results.BadRequest(new { error = "Comment limit reached." });

    var name = Api.Clean(req.Name, 60);
    var text = Api.Clean(req.Text, 2000);
    if (name is null || text is null)
        return Results.BadRequest(new { error = "Name and comment are both required." });

    var comment = new Comment { Id = Id.New(8), Name = name, Text = text, EditToken = Id.New(24) };
    if (!await store.AddCommentAsync(publicId, comment, Api.MaxComments))
        return Results.BadRequest(new { error = "Comment limit reached." });

    return Results.Ok(new { id = comment.Id, editToken = comment.EditToken });
}).RequireRateLimiting(RateLimits.Writes);

// Delete a comment. Author or admin.
api.MapDelete("/polls/{publicId}/comments/{commentId}", async (
    string publicId, string commentId, HttpContext ctx, PollStore store) =>
{
    var poll = await store.GetByPublicIdAsync(publicId);
    if (poll is null) return Results.NotFound();

    var comment = poll.Comments.FirstOrDefault(c => c.Id == commentId);
    if (comment is null) return Results.NotFound();

    if (!Api.IsAdmin(ctx, poll) && !Api.HasEditToken(ctx, comment.EditToken))
        return Results.StatusCode(StatusCodes.Status403Forbidden);

    await store.RemoveCommentAsync(publicId, commentId);
    return Results.Ok(new { ok = true });
}).RequireRateLimiting(RateLimits.Writes);

// Admin: retitle, edit description, open or close voting.
api.MapPatch("/polls/{publicId}", async (
    string publicId, UpdatePollRequest req, HttpContext ctx, PollStore store) =>
{
    var poll = await store.GetByPublicIdAsync(publicId);
    if (poll is null) return Results.NotFound();
    if (!Api.IsAdmin(ctx, poll)) return Results.StatusCode(StatusCodes.Status403Forbidden);

    // Only the supplied fields are written, so closing a poll cannot revert someone's vote that
    // landed between this request being read and being saved.
    await store.UpdatePollAsync(
        publicId,
        Api.Clean(req.Title, 120),
        req.Description is null ? null : Api.Clean(req.Description, 2000),
        req.Description is not null,
        req.Closed,
        Api.ParseDeadline(req.Deadline),
        req.Deadline is not null,
        req.AllowMaybe);

    return Results.Ok(new { ok = true });
}).RequireRateLimiting(RateLimits.Writes);

// Admin: add more dates. A typo used to mean deleting the poll and losing every vote with it.
api.MapPost("/polls/{publicId}/options", async (
    string publicId, AddOptionsRequest req, HttpContext ctx, PollStore store) =>
{
    var poll = await store.GetByPublicIdAsync(publicId);
    if (poll is null) return Results.NotFound();
    if (!Api.IsAdmin(ctx, poll)) return Results.StatusCode(StatusCodes.Status403Forbidden);

    // Skip dates the poll already offers, so adding a batch twice does not duplicate columns.
    var seen = poll.Options.Select(o => $"{o.Date}|{o.Time}").ToHashSet(StringComparer.Ordinal);
    var options = Api.BuildOptions(req.Options).Where(o => seen.Add($"{o.Date}|{o.Time}")).ToList();

    if (options.Count == 0) return Results.BadRequest(new { error = "Add at least one date that is not already here." });
    if (poll.Options.Count + options.Count > Api.MaxOptions)
        return Results.BadRequest(new { error = $"A poll can hold {Api.MaxOptions} options." });

    if (!await store.AddOptionsAsync(publicId, options, Api.MaxOptions))
        return Results.BadRequest(new { error = "This poll is full." });

    return Results.Ok(new { added = options.Count });
}).RequireRateLimiting(RateLimits.Writes);

// Admin: remove one date. Any votes cast on it go too, which the client warns about first.
api.MapDelete("/polls/{publicId}/options/{optionId}", async (
    string publicId, string optionId, HttpContext ctx, PollStore store) =>
{
    var poll = await store.GetByPublicIdAsync(publicId);
    if (poll is null) return Results.NotFound();
    if (!Api.IsAdmin(ctx, poll)) return Results.StatusCode(StatusCodes.Status403Forbidden);
    if (poll.Options.All(o => o.Id != optionId)) return Results.NotFound();
    if (poll.Options.Count <= 1) return Results.BadRequest(new { error = "A poll needs at least one date." });

    await store.RemoveOptionAsync(publicId, optionId);
    return Results.Ok(new { ok = true });
}).RequireRateLimiting(RateLimits.Writes);

// Edit a comment. Author or admin. The edit token that authorises this already existed.
api.MapPut("/polls/{publicId}/comments/{commentId}", async (
    string publicId, string commentId, CommentEditRequest req, HttpContext ctx, PollStore store) =>
{
    var poll = await store.GetByPublicIdAsync(publicId);
    if (poll is null) return Results.NotFound();

    var comment = poll.Comments.FirstOrDefault(c => c.Id == commentId);
    if (comment is null) return Results.NotFound();
    if (!Api.IsAdmin(ctx, poll) && !Api.HasEditToken(ctx, comment.EditToken))
        return Results.StatusCode(StatusCodes.Status403Forbidden);

    var text = Api.Clean(req.Text, 2000);
    if (text is null) return Results.BadRequest(new { error = "A comment cannot be empty." });

    await store.UpdateCommentAsync(publicId, commentId, text);
    return Results.Ok(new { ok = true });
}).RequireRateLimiting(RateLimits.Writes);

// Admin: delete the whole poll.
api.MapDelete("/polls/{publicId}", async (string publicId, HttpContext ctx, PollStore store) =>
{
    var poll = await store.GetByPublicIdAsync(publicId);
    if (poll is null) return Results.NotFound();
    if (!Api.IsAdmin(ctx, poll)) return Results.StatusCode(StatusCodes.Status403Forbidden);

    await store.DeleteAsync(poll.AdminId);
    return Results.Ok(new { ok = true });
}).RequireRateLimiting(RateLimits.Writes);

// Anything nothing else claimed. A person following a dead link gets a page with a way home; API and
// auth callers, and any method other than GET, keep the bare 404 they always had.
app.MapFallback("{*path}", async ctx =>
{
    ctx.Response.StatusCode = StatusCodes.Status404NotFound;
    var path = ctx.Request.Path;
    if (path.StartsWithSegments("/api") || path.StartsWithSegments("/auth")) return;
    if (!HttpMethods.IsGet(ctx.Request.Method) && !HttpMethods.IsHead(ctx.Request.Method)) return;
    await SendPage(ctx, "404.html");
});

app.Run();
