import io.gh.akshat.tizentube.gate.BundleServer;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

public final class BundleServerTest {
    private static String request(BundleServer server, String request) throws Exception {
        try (Socket socket = new Socket("127.0.0.1", server.port())) {
            socket.setSoTimeout(3000);
            socket.getOutputStream().write(request.getBytes(StandardCharsets.US_ASCII));
            socket.getOutputStream().flush();
            return new String(socket.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    public static void main(String[] args) throws Exception {
        byte[] script = "window.syntheticGate = true;".getBytes(StandardCharsets.UTF_8);
        try (BundleServer server = new BundleServer(script, 0)) {
            String get = request(server, "GET /tube.js HTTP/1.1\r\nHost: localhost\r\n\r\n");
            assert get.contains("200 OK") && get.endsWith(new String(script, StandardCharsets.UTF_8));
            String head = request(server, "HEAD /tube.js HTTP/1.1\r\n\r\n");
            assert head.contains("Content-Length: " + script.length) && head.endsWith("\r\n\r\n");
            assert request(server, "GET /tube.js?build=fixture&v=2 HTTP/1.1\r\n\r\n").contains("200 OK");
            String options = request(server, "OPTIONS /tube.js HTTP/1.1\r\nOrigin: https://www.youtube.com\r\n\r\n");
            assert options.contains("Access-Control-Allow-Private-Network: true");
            assert request(server, "POST /tube.js HTTP/1.1\r\n\r\n").contains("405 Method Not Allowed");
            assert request(server, "GET /settings HTTP/1.1\r\n\r\n").contains("404 Not Found");
            assert request(server, "GET /../private HTTP/1.1\r\n\r\n").contains("404 Not Found");
            String foreign = request(server, "GET /tube.js HTTP/1.1\r\nOrigin: https://example.invalid\r\n\r\n");
            assert !foreign.contains("Access-Control-Allow-Origin");
        }
        System.out.println("8/8 loopback-only bundle server checks passed");
    }
}
