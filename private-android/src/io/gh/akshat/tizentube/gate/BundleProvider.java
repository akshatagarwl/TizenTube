package io.gh.akshat.tizentube.gate;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

public final class BundleProvider extends ContentProvider {
    private BundleServer server;

    @Override public boolean onCreate() {
        try (InputStream input = getContext().getAssets().open("playback-gate.js")) {
            ByteArrayOutputStream script = new ByteArrayOutputStream();
            byte[] buffer = new byte[16384];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (script.size() + count > 4 * 1024 * 1024) throw new IOException("Bundle too large");
                script.write(buffer, 0, count);
            }
            server = new BundleServer(script.toByteArray(), 8107);
            return true;
        } catch (IOException error) {
            Log.e("PlaybackGate", "Local bundled script is unavailable", error);
            return false;
        }
    }

    @Override public Cursor query(Uri uri, String[] projection, String selection,
                                  String[] selectionArgs, String sortOrder) {
        throw new UnsupportedOperationException("No data endpoint");
    }
    @Override public String getType(Uri uri) { return null; }
    @Override public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("Read only");
    }
    @Override public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("Read only");
    }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("Read only");
    }
}
