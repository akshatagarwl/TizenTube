package io.gh.akshat.tizentube.gate;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Read-only, loopback-only transport for the APK's bundled JavaScript. */
public final class BundleServer implements Closeable {
    private final byte[] script;
    private final ServerSocket server;
    private final ThreadPoolExecutor workers;

    public BundleServer(byte[] script, int port) throws IOException {
        this.script = script.clone();
        server = new ServerSocket(port, 8, InetAddress.getByName("127.0.0.1"));
        workers = new ThreadPoolExecutor(2, 2, 0, TimeUnit.SECONDS,
                new ArrayBlockingQueue<>(8), task -> daemon(task, "playback-bundle-worker"));
        daemon(this::accept, "playback-bundle-listener").start();
    }

    private static Thread daemon(Runnable task, String name) {
        Thread thread = new Thread(task, name);
        thread.setDaemon(true);
        return thread;
    }

    public int port() { return server.getLocalPort(); }

    private void accept() {
        while (!server.isClosed()) {
            try {
                Socket connection = server.accept();
                connection.setSoTimeout(3000);
                try {
                    workers.execute(() -> serve(connection));
                } catch (RejectedExecutionException full) {
                    connection.close();
                }
            } catch (IOException error) {
                if (!server.isClosed()) System.err.println("Playback bundle accept failed: " + error);
            }
        }
    }

    private static String line(InputStream input) throws IOException {
        StringBuilder text = new StringBuilder();
        while (text.length() < 4096) {
            int character = input.read();
            if (character == -1 || character == '\n') return text.toString().trim();
            text.append((char) character);
        }
        throw new IOException("Oversized HTTP header");
    }

    private void serve(Socket connection) {
        try (Socket socket = connection) {
            InputStream input = socket.getInputStream();
            String[] request = line(input).split(" ");
            if (request.length != 3) return;
            String origin = "";
            int headerBytes = 0;
            while (headerBytes < 16384) {
                String header = line(input);
                if (header.isEmpty()) break;
                headerBytes += header.length();
                if (header.regionMatches(true, 0, "Origin:", 0, 7)) origin = header.substring(7).trim();
            }
            if (headerBytes >= 16384) return;
            String path = request[1].split("\\?", 2)[0];
            boolean correctPath = path.equals("/tube.js");
            boolean read = request[0].equals("GET") || request[0].equals("HEAD");
            boolean preflight = request[0].equals("OPTIONS");
            String status = "404 Not Found";
            if (correctPath) status = read || preflight ? "200 OK" : "405 Method Not Allowed";
            byte[] body = correctPath && read ? script : new byte[0];
            String cors = "";
            if (origin.equals("https://www.youtube.com") || origin.equals("https://youtube.com")) {
                cors = "Access-Control-Allow-Origin: " + origin + "\r\n"
                        + "Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n"
                        + "Access-Control-Allow-Private-Network: true\r\n";
            }
            String headers = "HTTP/1.1 " + status + "\r\n"
                    + "Content-Type: application/javascript; charset=utf-8\r\n"
                    + "Content-Length: " + body.length + "\r\n"
                    + "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n"
                    + "Connection: close\r\n" + cors + "\r\n";
            OutputStream output = socket.getOutputStream();
            output.write(headers.getBytes(StandardCharsets.US_ASCII));
            if (request[0].equals("GET")) output.write(body);
            output.flush();
        } catch (IOException error) {
            System.err.println("Playback bundle request failed: " + error.getClass().getSimpleName());
        }
    }

    @Override public void close() throws IOException {
        server.close();
        workers.shutdownNow();
    }
}
