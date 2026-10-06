package app;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

// Serves the UI from public/ (see application.properties) and runs Agent Hub workflows; the tokens in jr-workflows.json never reach the browser.
@SpringBootApplication
@RestController
public class Application {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

    public static void main(String[] args) {
        SpringApplication.run(Application.class, args);
    }

    private static ObjectNode result(String status, JsonNode output, String error) {
        ObjectNode body = JSON.createObjectNode();
        body.put("status", status);
        body.set("output", output);
        body.put("error", error);
        return body;
    }

    @PostMapping("/api/workflows/{key}")
    public ResponseEntity<JsonNode> runWorkflow(@PathVariable String key, @RequestBody(required = false) JsonNode input) {
        JsonNode cfg;
        try {
            cfg = JSON.readTree(Files.readString(Path.of("jr-workflows.json")));
        } catch (Exception e) {
            cfg = JSON.createObjectNode();
        }
        JsonNode flow = cfg.path("workflows").path(key);
        if (flow.isMissingNode()) {
            System.out.println("[workflow] " + key + ": unknown workflow (check jr-workflows.json)");
            return ResponseEntity.status(404).body(result("failed", null, "Unknown workflow"));
        }
        long started = System.currentTimeMillis();
        String base = cfg.path("base").asText();
        try {
            ObjectNode payload = JSON.createObjectNode();
            payload.set("input", input == null ? JSON.createObjectNode() : input);
            HttpRequest req = HttpRequest.newBuilder(URI.create(base + "/hooks/workflows/" + flow.path("id").asText() + "/run"))
                .timeout(Duration.ofMinutes(3))
                .header("Content-Type", "application/json")
                .header("Authorization", "Bearer " + flow.path("token").asText())
                .POST(HttpRequest.BodyPublishers.ofString(payload.toString()))
                .build();
            HttpResponse<String> res = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
            JsonNode run = JSON.readTree(res.body().isEmpty() ? "{}" : res.body());
            int code = res.statusCode() < 300 ? 200 : res.statusCode();
            System.out.println("[workflow] " + key + " -> " + run.path("status").asText(String.valueOf(res.statusCode())) + " in " + (System.currentTimeMillis() - started) + "ms " + run.path("error").asText(""));
            return ResponseEntity.status(code).body(result(run.path("status").asText("failed"), run.get("output"), run.path("error").asText(null)));
        } catch (Exception e) {
            System.out.println("[workflow] " + key + ": could not reach " + base + " (" + e.getMessage() + ")");
            return ResponseEntity.status(502).body(result("failed", null, "Could not reach Jr Architect at " + base));
        }
    }
}
