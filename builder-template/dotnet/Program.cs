// Serves the UI from public/ and runs Agent Hub workflows for it; the tokens in jr-workflows.json never reach the browser.
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.FileProviders;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
var http = new HttpClient { Timeout = TimeSpan.FromMinutes(3) };
var publicFiles = new PhysicalFileProvider(Path.Combine(Directory.GetCurrentDirectory(), "public"));

app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = publicFiles });
app.UseStaticFiles(new StaticFileOptions { FileProvider = publicFiles });

app.MapPost("/api/workflows/{key}", async (string key, HttpRequest request) =>
{
    JsonNode cfg;
    try { cfg = JsonNode.Parse(await File.ReadAllTextAsync("jr-workflows.json")) ?? new JsonObject(); }
    catch { cfg = new JsonObject(); }
    var flow = cfg["workflows"]?[key];
    if (flow is null)
    {
        Console.WriteLine($"[workflow] {key}: unknown workflow (check jr-workflows.json)");
        return Results.Json(new { status = "failed", error = "Unknown workflow" }, statusCode: 404);
    }
    var started = DateTime.UtcNow;
    JsonNode? input = null;
    try { input = await JsonNode.ParseAsync(request.Body); } catch (JsonException) { }
    input ??= new JsonObject();
    var baseUrl = (string?)cfg["base"] ?? "";
    try
    {
        var call = new HttpRequestMessage(HttpMethod.Post, $"{baseUrl}/hooks/workflows/{flow["id"]}/run")
        {
            Content = JsonContent.Create(new JsonObject { ["input"] = input }),
        };
        call.Headers.Add("Authorization", $"Bearer {flow["token"]}");
        var res = await http.SendAsync(call);
        var text = await res.Content.ReadAsStringAsync();
        var run = string.IsNullOrWhiteSpace(text) ? new JsonObject() : JsonNode.Parse(text) ?? new JsonObject();
        var code = (int)res.StatusCode < 300 ? 200 : (int)res.StatusCode;
        Console.WriteLine($"[workflow] {key} -> {(string?)run["status"] ?? res.StatusCode.ToString()} in {(int)(DateTime.UtcNow - started).TotalMilliseconds}ms {(string?)run["error"]}");
        return Results.Json(new { status = (string?)run["status"] ?? "failed", output = run["output"], error = (string?)run["error"] }, statusCode: code);
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
    {
        Console.WriteLine($"[workflow] {key}: could not reach {baseUrl} ({ex.Message})");
        return Results.Json(new { status = "failed", error = $"Could not reach Jr Architect at {baseUrl}" }, statusCode: 502);
    }
});

app.Run();
