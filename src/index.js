import { AwsClient } from "aws4fetch";

const COOKIE_NAME = "__Host-chizui_file_login";
const SESSION_MAX_AGE = 1800; // 30 menit

// Ubah ini kalau mau limit storage beda
const STORAGE_LIMIT = 10 * 1024 * 1024 * 1024; // 10 GB

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const rawPath = decodeURIComponent(url.pathname.slice(1));

    // LOGIN
    if (url.pathname === "/login") {
      if (request.method === "POST") {
        const form = await request.formData();
        const user = form.get("username");
        const pass = form.get("password");

        const adminUser = env.USERNAME;
        const adminPass = env.PASSWORD;
        const viewerUser = env.VIEWER_USERNAME;
        const viewerPass = env.VIEWER_PASSWORD;

        if (!adminUser || !adminPass || !viewerUser || !viewerPass || !env.SECRET_KEY) {
          return new Response("Security Error: Secrets (USERNAME/PASSWORD/VIEWER_USERNAME/VIEWER_PASSWORD/SECRET_KEY) are not configured in Cloudflare.", { status: 500 });
        }

        const role = user === adminUser && pass === adminPass
          ? "admin"
          : user === viewerUser && pass === viewerPass
            ? "viewer"
            : "";

        if (role) {
          const expiration = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE;
          const fingerprint = await sessionFingerprint(request, env);
          const payload = `${role}:${expiration}:${fingerprint}`;
          const signature = await sign(payload, env.SECRET_KEY);
          const cookieValue = `${payload}.${signature}`;

          return new Response(null, {
            status: 302,
            headers: {
              Location: "/",
              "Set-Cookie": `${COOKIE_NAME}=${cookieValue}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}`
            }
          });
        }

        return html(loginPage("Username atau password salah"), 401);
      }

      return html(loginPage(""));
    }

    // LOGOUT
    if (url.pathname === "/logout") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/",
          "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
        }
      });
    }

    // UPLOAD
    if (request.method === "POST" && url.pathname === "/upload") {
      if (!(await isAdmin(request, env))) {
        return new Response("Unauthorized. Login sebagai admin dulu untuk upload.", { status: 401 });
      }

      try {
        const formData = await request.formData();
        const files = formData.getAll("files");
        const prefix = formData.get("prefix") || "";

        if (!files || files.length === 0) {
          return new Response("No files uploaded", { status: 400 });
        }

        const cleanPrefix = sanitizePrefix(prefix);

        for (const file of files) {
          if (typeof file === "string") continue;
          const key = cleanPrefix + file.name;

          // Stream file directly to R2 to reduce memory pressure on large uploads.
          await env.BUCKET.put(key, file.stream(), {
            httpMetadata: {
              contentType: file.type || guessContentType(file.name)
            }
          });
        }

        return Response.redirect(url.origin + "/?prefix=" + encodeURIComponent(cleanPrefix), 302);
      } catch (error) {
        console.error("Upload failed:", error);
        return new Response("Upload gagal. Coba file lebih kecil atau upload satu per satu.", { status: 500 });
      }
    }

    // DIRECT UPLOAD (faster path: no multipart parsing in Worker)
    if (request.method === "POST" && url.pathname === "/upload-direct") {
      if (!(await isAdmin(request, env))) {
        return new Response("Unauthorized. Login sebagai admin dulu untuk upload.", { status: 401 });
      }

      const keyParam = url.searchParams.get("key");
      const prefixParam = url.searchParams.get("prefix") || "";
      const fileType = request.headers.get("content-type") || "application/octet-stream";

      if (!keyParam) {
        return new Response("Key required", { status: 400 });
      }

      const cleanPrefix = sanitizePrefix(prefixParam);
      const safeName = keyParam.replace(/^\/+/, "").split("/").pop();
      if (!safeName) {
        return new Response("Invalid file name", { status: 400 });
      }

      const objectKey = cleanPrefix + safeName;

      try {
        await env.BUCKET.put(objectKey, request.body, {
          httpMetadata: {
            contentType: fileType
          }
        });
        return new Response("OK", { status: 200 });
      } catch (error) {
        console.error("Direct upload failed:", error);
        return new Response("Upload gagal", { status: 500 });
      }
    }

    // PRESIGNED URL for direct browser -> R2 upload
    if (request.method === "POST" && url.pathname === "/upload-presign") {
      if (!(await isAdmin(request, env))) {
        return new Response("Unauthorized. Login sebagai admin dulu untuk upload.", { status: 401 });
      }

      const accountId = env.R2_ACCOUNT_ID;
      const accessKeyId = env.R2_ACCESS_KEY_ID;
      const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
      const bucketName = env.R2_BUCKET_NAME || "chizui-files";

      if (!accountId || !accessKeyId || !secretAccessKey) {
        return new Response("R2 presign secrets belum diset (R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY).", { status: 500 });
      }

      try {
        const payload = await request.json();
        const filename = String(payload?.filename || "");
        const prefix = String(payload?.prefix || "");
        const requestedType = String(payload?.contentType || "");
        const contentType = requestedType || guessContentType(filename);

        const safeName = filename.replace(/^\/+/, "").split("/").pop();
        if (!safeName) {
          return new Response("Filename invalid", { status: 400 });
        }

        const cleanPrefix = sanitizePrefix(prefix);
        const key = cleanPrefix + safeName;
        const encodedKey = encodeR2ObjectKey(key);

        const endpoint = new URL(`https://${accountId}.r2.cloudflarestorage.com/${bucketName}/${encodedKey}`);
        endpoint.searchParams.set("X-Amz-Expires", "900");

        const r2 = new AwsClient({ accessKeyId, secretAccessKey });
        const signed = await r2.sign(
          new Request(endpoint.toString(), {
            method: "PUT",
            headers: { "Content-Type": contentType }
          }),
          {
            aws: {
              signQuery: true
            }
          }
        );

        return Response.json({
          url: signed.url,
          method: "PUT",
          key,
          headers: {
            "Content-Type": contentType
          }
        });
      } catch (error) {
        console.error("Presign error:", error);
        return new Response("Gagal generate upload URL", { status: 500 });
      }
    }

    // MKDIR (Create Folder)
    if (request.method === "POST" && url.pathname === "/mkdir") {
      if (!(await isAdmin(request, env))) {
        return new Response("Unauthorized", { status: 401 });
      }

      const formData = await request.formData();
      const folderName = formData.get("folderName");
      const prefix = formData.get("prefix") || "";

      if (!folderName) {
        return new Response("Folder name required", { status: 400 });
      }

      const cleanPrefix = sanitizePrefix(prefix);
      const folderKey = cleanPrefix + folderName.replace(/\/+$/, "") + "/";

      // R2 "folders" are just zero-byte objects ending in /
      await env.BUCKET.put(folderKey, new ArrayBuffer(0));

      return Response.redirect(url.origin + "/?prefix=" + encodeURIComponent(cleanPrefix), 302);
    }

    // DELETE (File or Folder)
    if (request.method === "POST" && url.pathname === "/delete") {
      if (!(await isAdmin(request, env))) {
        return new Response("Unauthorized", { status: 401 });
      }

      const formData = await request.formData();
      const key = formData.get("key");
      const prefix = formData.get("prefix") || "";

      if (!key) {
        return new Response("Key required", { status: 400 });
      }

      if (key.endsWith("/")) {
        const objectsToDelete = await listAllObjectsWithPrefix(env.BUCKET, key);
        for (const obj of objectsToDelete) {
          await env.BUCKET.delete(obj.key);
        }
      } else {
        await env.BUCKET.delete(key);
      }

      return Response.redirect(url.origin + "/?prefix=" + encodeURIComponent(prefix), 302);
    }

    // EDIT TEXT FILE
    if (url.pathname === "/edit") {
      if (!(await isAdmin(request, env))) {
        return new Response("Unauthorized", { status: 401 });
      }

      const key = url.searchParams.get("key");
      if (!key) return new Response("Key required", { status: 400 });

      if (request.method === "POST") {
        const formData = await request.formData();
        const content = formData.get("content");
        await env.BUCKET.put(key, content, {
          httpMetadata: { contentType: "text/plain" }
        });
        const prefix = getParentPrefix(key);
        return Response.redirect(url.origin + "/?prefix=" + encodeURIComponent(prefix), 302);
      }

      const object = await env.BUCKET.get(key);
      if (!object) return new Response("File not found", { status: 404 });

      const content = await object.text();
      return html(editPage(key, content));
    }

    // DOWNLOAD / PREVIEW FILE
    if (rawPath) {
      const session = await getSession(request, env);
      if (!session) {
        return redirectToLogin(url);
      }

      const isDownload = url.searchParams.get("download") === "1";
      const range = request.headers.get("Range");
      const object = request.method === "HEAD"
        ? await env.BUCKET.head(rawPath)
        : await env.BUCKET.get(rawPath, range && !isDownload ? { range: request.headers } : undefined);

      if (!object) {
        return new Response("File not found", { status: 404 });
      }

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("Accept-Ranges", isDownload ? "none" : "bytes");

      if (object.range && !isDownload) {
        const rangeLength = object.range.length ?? object.size - object.range.offset;
        headers.set("Content-Range", `bytes ${object.range.offset}-${object.range.offset + rangeLength - 1}/${object.size}`);
        headers.set("Content-Length", String(rangeLength));
      } else {
        headers.delete("Content-Range");
        headers.set("Content-Length", String(object.size));
      }

      const metadataContentType = headers.get("content-type");
      const guessedContentType = guessContentType(rawPath);
      const contentType = !metadataContentType || metadataContentType === "application/octet-stream"
        ? guessedContentType
        : metadataContentType;
      headers.set("Content-Type", contentType);

      const dispositionType = isDownload || !isPreviewable(contentType, rawPath)
        ? "attachment"
        : "inline";
      headers.set("Content-Disposition", contentDisposition(dispositionType, rawPath));
      if (isDownload) {
        headers.set("Cache-Control", "no-store");
      }

      const responseStatus = object.range && !isDownload ? 206 : 200;

      if (request.method === "HEAD") {
        return new Response(null, {
          headers,
          status: responseStatus
        });
      }

      return new Response(object.body, { 
        headers, 
        status: responseStatus 
      });
    }

    const session = await getSession(request, env);
    if (!session) {
      return redirectToLogin(url);
    }

    const isAdminUser = session.role === "admin";

    // Get all objects once for both stats and search
    const allFiles = await listAllObjects(env.BUCKET);
    const storageUsed = allFiles.reduce((total, file) => total + file.size, 0);
    const storagePercent = Math.min((storageUsed / STORAGE_LIMIT) * 100, 100);

    // SEARCH LOGIC
    const search = url.searchParams.get("q") || "";
    const prefix = sanitizePrefix(url.searchParams.get("prefix") || "");
    let rows = "";
    let isSearching = !!search;

    if (isSearching) {
      const filtered = allFiles.filter(obj => 
        obj.key.toLowerCase().includes(search.toLowerCase())
      ).slice(0, 100);

      for (const file of filtered) {
        const type = guessContentType(file.key);
        const previewable = isPreviewable(type, file.key);
        const isFolder = file.key.endsWith("/") && file.size === 0;

        rows += `
<tr>
  <td>
    <a class="file-link" href="${objectUrl(url.origin, file.key)}" ${previewable ? `target="_blank"` : ""}>
      <span class="icon">${isFolder ? "📁" : getIcon(file.key)}</span>${escapeHtml(file.key)}
    </a>
  </td>
  <td><span class="type-badge">${isFolder ? "Folder" : getFileType(file.key)}</span></td>
  <td>${isFolder ? "-" : formatBytes(file.size)}</td>
  <td>${new Date(file.uploaded).toLocaleString()}</td>
  <td>
    <div class="file-actions">
      ${isFolder ? `<a class="btn btn-tonal" href="/?prefix=${encodeURIComponent(file.key)}">Open</a>` : `
        ${previewable ? `<a class="btn btn-tonal" href="${objectUrl(url.origin, file.key)}" target="_blank">Preview</a>` : ""}
        <a class="btn btn-outlined" href="${objectUrl(url.origin, file.key, true)}">Download</a>
      `}
    </div>
  </td>
</tr>`;
      }
    } else {
      // LIST FOLDER LOGIC
      const listed = await env.BUCKET.list({
        prefix,
        delimiter: "/"
      });

      if (prefix) {
        const parent = getParentPrefix(prefix);
        rows += `
<tr>
  <td>
    <a class="file-link" href="/${parent ? `?prefix=${encodeURIComponent(parent)}` : ""}">
      <span class="icon">⬅️</span> Parent directory/
    </a>
  </td>
  <td><span class="type-badge">Folder</span></td>
  <td>-</td>
  <td>-</td>
  <td></td>
</tr>`;
      }

      for (const folder of listed.delimitedPrefixes || []) {
        const folderName = folder.replace(prefix, "");

        rows += `
<tr>
  <td>
    <a class="file-link" href="/?prefix=${encodeURIComponent(folder)}">
      <span class="icon">📁</span>${escapeHtml(folderName)}
    </a>
  </td>
  <td><span class="type-badge">Folder</span></td>
  <td>-</td>
  <td>-</td>
  <td>
    <div class="file-actions">
      <a class="btn btn-tonal" href="/?prefix=${encodeURIComponent(folder)}">Open</a>
      ${isAdminUser ? `
      <form method="POST" action="/delete" onsubmit="return confirm('Hapus folder ini?')">
        <input type="hidden" name="key" value="${escapeHtml(folder)}">
        <input type="hidden" name="prefix" value="${escapeHtml(prefix)}">
        <button type="submit" class="btn btn-outlined btn-danger" style="color:var(--md-sys-color-error); border-color:var(--md-sys-color-error)">Delete</button>
      </form>` : ""}
    </div>
  </td>
</tr>`;
      }

      for (const file of listed.objects) {
        if (file.key === prefix) continue;
        if (file.key.endsWith("/") && file.size === 0) continue;

        const displayName = file.key.replace(prefix, "");
        if (!displayName || displayName.includes("/")) continue;

        const type = guessContentType(file.key);
        const previewable = isPreviewable(type, file.key);

        rows += `
<tr>
  <td>
    <a class="file-link" href="${objectUrl(url.origin, file.key)}" ${previewable ? `target="_blank"` : ""}>
      <span class="icon">${getIcon(file.key)}</span>${escapeHtml(displayName)}
    </a>
  </td>
  <td><span class="type-badge">${getFileType(file.key)}</span></td>
  <td>${formatBytes(file.size)}</td>
  <td>${new Date(file.uploaded).toLocaleString()}</td>
  <td>
    <div class="file-actions">
      ${previewable ? `<a class="btn btn-tonal" href="${objectUrl(url.origin, file.key)}" target="_blank">Preview</a>` : ""}
      <a class="btn btn-outlined" href="${objectUrl(url.origin, file.key, true)}">Download</a>
      ${isAdminUser && file.key.toLowerCase().endsWith(".txt") ? `<a class="btn btn-tonal" href="/edit?key=${encodeURIComponent(file.key)}">Edit</a>` : ""}
      ${isAdminUser ? `
      <form method="POST" action="/delete" onsubmit="return confirm('Hapus file ini?')">
        <input type="hidden" name="key" value="${escapeHtml(file.key)}">
        <input type="hidden" name="prefix" value="${escapeHtml(prefix)}">
        <button type="submit" class="btn btn-outlined btn-danger" style="color:var(--md-sys-color-error); border-color:var(--md-sys-color-error)">Delete</button>
      </form>` : ""}
    </div>
  </td>
</tr>`;
      }
    }

    // Visitor count logic
    let visitorCount = 0;
    try {
      if (env.STATS) {
        if (url.pathname === "/") {
          const currentCount = await env.STATS.get("visitor_count") || "0";
          visitorCount = parseInt(currentCount) + 1;
          await env.STATS.put("visitor_count", visitorCount.toString());
        } else {
          visitorCount = parseInt(await env.STATS.get("visitor_count") || "0");
        }
      }
    } catch (e) {
      console.error("KV Error:", e);
    }

    return html(mainPage({
      rows,
      isAdmin: isAdminUser,
      userRole: session.role,
      prefix,
      storageUsed,
      storageLimit: STORAGE_LIMIT,
      storagePercent,
      visitorCount,
      isSearching,
      searchQuery: search,
      allFiles: allFiles.map(f => ({
        key: f.key,
        size: f.size,
        uploaded: f.uploaded
      })),
      origin: url.origin
    }));
  }
};

async function listAllObjects(bucket) {
  let cursor;
  let objects = [];

  do {
    const result = await bucket.list({ cursor });
    objects = objects.concat(result.objects);
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);

  return objects;
}

async function listAllObjectsWithPrefix(bucket, prefix) {
  let cursor;
  let objects = [];

  do {
    const result = await bucket.list({ cursor, prefix });
    objects = objects.concat(result.objects);
    cursor = result.truncated ? result.cursor : undefined;
  } while (cursor);

  return objects;
}

function mainPage({ rows, isAdmin, userRole, prefix, storageUsed, storageLimit, storagePercent, visitorCount, isSearching, searchQuery, allFiles, origin }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Files — ${escapeHtml(prefix || "Root")}</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600&family=Roboto+Mono&display=swap" rel="stylesheet">
<style>
:root {
  --md-sys-color-primary: #D0BCFF;
  --md-sys-color-on-primary: #381E72;
  --md-sys-color-primary-container: #4F378B;
  --md-sys-color-on-primary-container: #EADDFF;
  --md-sys-color-secondary: #CCC2DC;
  --md-sys-color-on-secondary: #332D41;
  --md-sys-color-surface: #1C1B1F;
  --md-sys-color-on-surface: #E6E1E5;
  --md-sys-color-surface-variant: #49454F;
  --md-sys-color-on-surface-variant: #CAC4D0;
  --md-sys-color-outline: #938F99;
  --md-sys-color-error: #F2B8B5;
  --md-sys-color-background: #141218;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  background-color: var(--md-sys-color-background);
  color: var(--md-sys-color-on-surface);
  font-family: 'Outfit', sans-serif;
  -webkit-font-smoothing: antialiased;
  min-height: 100vh;
}

.container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 40px 24px;
}

/* Header & Path */
.top-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 32px;
  gap: 20px;
}

.path-container {
  flex: 1;
  background: var(--md-sys-color-surface-variant);
  padding: 0 24px;
  height: 48px;
  border-radius: 24px;
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--md-sys-color-on-surface-variant);
  font-weight: 500;
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
}

.path-container h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.top-bar .actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* Storage Card */
.storage-card {
  background: var(--md-sys-color-primary-container);
  color: var(--md-sys-color-on-primary-container);
  padding: 24px;
  border-radius: 24px;
  margin-bottom: 24px;
}

.storage-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 12px;
  font-weight: 600;
}

.progress-track {
  height: 8px;
  background: rgba(255,255,255,0.2);
  border-radius: 4px;
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  background: var(--md-sys-color-primary);
  transition: width 0.3s ease;
}

/* Buttons */
.btn {
  padding: 0 24px;
  height: 40px;
  border-radius: 20px;
  border: none;
  font-weight: 500;
  font-size: 14px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  text-decoration: none;
  transition: all 0.2s ease;
}

.btn-filled {
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
}

.btn-filled:hover { opacity: 0.9; box-shadow: 0 1px 3px rgba(0,0,0,0.3); }

.btn-tonal {
  background: var(--md-sys-color-secondary);
  color: var(--md-sys-color-on-secondary);
}

.btn-outlined {
  background: transparent;
  border: 1px solid var(--md-sys-color-outline);
  color: var(--md-sys-color-primary);
}

.btn-danger {
  background: #8C1D18;
  color: white;
}

.role-badge {
  height: 40px;
  padding: 0 16px;
  border: 1px solid var(--md-sys-color-outline);
  border-radius: 20px;
  color: var(--md-sys-color-on-surface-variant);
  display: inline-flex;
  align-items: center;
  font-size: 14px;
  font-weight: 500;
}

td .btn {
  padding: 0 12px;
  height: 32px;
  font-size: 12px;
  border-radius: 12px;
  min-width: 76px;
  justify-content: center;
  text-align: center;
  white-space: nowrap;
}

td form { display: inline-flex; margin: 0; }

.file-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
  max-width: 100%;
}

.file-actions .btn {
  flex: 0 0 auto;
}

/* Table / File List */
.card {
  background: var(--md-sys-color-surface);
  border: 1px solid var(--md-sys-color-surface-variant);
  border-radius: 24px;
  overflow: hidden;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th:last-child,
td:last-child {
  width: 220px;
  padding-left: 18px;
  padding-right: 18px;
}

th {
  padding: 16px 24px;
  text-align: left;
  font-size: 13px;
  color: var(--md-sys-color-on-surface-variant);
  border-bottom: 1px solid var(--md-sys-color-surface-variant);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

td {
  padding: 16px 24px;
  border-bottom: 1px solid var(--md-sys-color-surface-variant);
}

tr:last-child td { border-bottom: none; }

tr:hover { background: rgba(255,255,255,0.03); }

.file-link {
  color: var(--md-sys-color-on-surface);
  text-decoration: none;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.file-link:hover { color: var(--md-sys-color-primary); }

.file-link .icon {
  flex: 0 0 auto;
}

.type-badge {
  background: var(--md-sys-color-surface-variant);
  color: var(--md-sys-color-on-surface-variant);
  padding: 6px 12px;
  border-radius: 8px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  display: inline-block;
  letter-spacing: 0.3px;
}

/* Admin Tools */
.admin-tools {
  margin-bottom: 24px;
  padding: 20px 24px;
  display: flex;
  flex-wrap: wrap;
  gap: 14px 20px;
  border: 1px solid var(--md-sys-color-surface-variant);
  border-radius: 24px;
  background: rgba(255,255,255,0.01);
  align-items: center;
}

.tool-group {
  display: flex;
  gap: 12px;
  align-items: center;
}

.admin-row {
  width: auto;
}

.folder-form {
  margin-left: auto;
}

.tool-group input[type="text"] {
  background: var(--md-sys-color-background);
  border: 1px solid var(--md-sys-color-outline);
  color: var(--md-sys-color-on-surface);
  padding: 0 16px;
  height: 40px;
  border-radius: 12px;
  outline: none;
  font-family: 'Outfit', sans-serif;
  min-width: 200px;
}

.tool-group input:focus { border-color: var(--md-sys-color-primary); }

.upload-form {
  min-width: 0;
  align-items: center;
  flex-wrap: wrap;
}

.upload-dropzone {
  flex: 0 0 240px;
  height: 40px;
  min-width: 240px;
  padding: 0 14px;
  border: 1px dashed var(--md-sys-color-outline);
  border-radius: 12px;
  background: rgba(208,188,255,0.04);
  color: var(--md-sys-color-on-surface-variant);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: border-color 0.2s ease, background 0.2s ease;
}

.upload-dropzone:hover,
.upload-dropzone.is-dragging {
  border-color: var(--md-sys-color-primary);
  background: rgba(208,188,255,0.1);
}

.upload-dropzone strong {
  color: var(--md-sys-color-on-surface);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}

.upload-dropzone span {
  font-size: 12px;
  white-space: nowrap;
  display: none;
}

.upload-input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}

.upload-controls {
  display: flex;
  gap: 8px;
  flex: 0 0 auto;
  align-items: center;
}

.upload-clear {
  padding: 0 16px;
}

.upload-list {
  display: none;
  flex: 0 0 auto;
}

.upload-list.has-files {
  display: flex;
}

.upload-chip {
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--md-sys-color-surface-variant);
  color: var(--md-sys-color-on-surface-variant);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.upload-progress {
  display: none;
  width: 100%;
  margin-top: 6px;
  gap: 8px;
  flex-direction: column;
}

.upload-progress.is-active {
  display: flex;
}

.upload-progress-text {
  font-size: 12px;
  color: var(--md-sys-color-on-surface-variant);
}

.upload-progress-track {
  height: 8px;
  width: 100%;
  border-radius: 999px;
  background: rgba(255,255,255,0.12);
  overflow: hidden;
}

.upload-progress-bar {
  height: 100%;
  width: 0%;
  background: var(--md-sys-color-primary);
  transition: width 0.15s linear;
}

/* Footer / Visitor */
.footer {
  margin-top: 48px;
  text-align: center;
}

.visitor-badge {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  background: var(--md-sys-color-surface-variant);
  padding: 8px 24px;
  border-radius: 16px;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 14px;
}

.visitor-badge b { color: var(--md-sys-color-primary); font-size: 16px; }

.search-form {
  display: flex;
  gap: 8px;
}

.search-form input {
  width: 100%;
  min-width: 0;
}

.search-wrap {
  flex: 1;
  max-width: 400px;
}

.clear-search-button {
  height: 48px;
  min-width: 82px;
  padding: 0 18px;
  border-radius: 24px;
  flex: 0 0 auto;
}

@media (max-width: 768px) {
  .container {
    padding: 24px 12px;
  }

  .top-bar {
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
    margin-bottom: 24px;
  }

  .path-container {
    width: 100%;
    padding: 0 18px;
  }

  .path-container h1 {
    font-size: 16px;
  }

  .search-wrap {
    width: 100%;
    max-width: none;
  }

  .search-form input {
    height: 44px !important;
  }

  .top-bar .actions {
    width: 100%;
    justify-content: flex-start;
  }

  .top-bar .actions .btn,
  .top-bar .actions .role-badge {
    flex: 0 0 auto;
  }

  .storage-card {
    padding: 20px;
    border-radius: 20px;
  }

  .storage-header {
    gap: 8px;
    flex-wrap: wrap;
  }

  .admin-tools {
    align-items: center;
    padding: 18px;
    border-radius: 20px;
  }

  .upload-form,
  .tool-group {
    width: 100%;
  }

  .folder-form {
    margin-left: 0;
  }

  .folder-form,
  .upload-form {
    flex-direction: row;
    align-items: center;
  }

  .tool-group input[type="text"] {
    min-width: 0;
    flex: 1 1 180px;
  }

  .tool-group .btn,
  .upload-controls .btn {
    width: auto;
    flex: 0 0 auto;
  }

  .upload-dropzone {
    flex: 1 1 220px;
    min-width: 0;
    justify-content: center;
  }

  .upload-dropzone strong {
    white-space: normal;
    text-align: center;
  }

  .upload-controls {
    width: auto;
    justify-content: flex-start;
  }

  .upload-chip {
    width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .card {
    border-radius: 20px;
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  table {
    min-width: 720px;
  }

  th:last-child,
  td:last-child {
    width: 190px;
    padding-left: 12px;
    padding-right: 12px;
  }

  th,
  td {
    padding: 14px 16px;
  }
}

@media (max-width: 480px) {
  .container {
    padding: 16px 10px;
  }

  .top-bar {
    gap: 8px;
  }

  .path-container {
    height: 42px;
  }

  .search-form input {
    height: 42px !important;
    padding: 0 18px !important;
  }

  .top-bar .actions .btn,
  .top-bar .actions .role-badge {
    height: 38px;
    padding: 0 18px;
  }

  .admin-tools {
    gap: 12px;
  }

  .folder-form,
  .upload-form {
    flex-wrap: wrap;
  }

  .upload-dropzone,
  .tool-group input[type="text"] {
    flex-basis: 100%;
  }

  .storage-header {
    flex-direction: row;
  }

  table {
    min-width: 720px;
  }

  .file-actions {
    flex-direction: row;
    align-items: center;
  }
}
</style>
</head>
<body>
<div class="container">
  <div class="top-bar">
    <div class="path-container">
      <span class="icon">📂</span>
      <h1>${isSearching ? `Search: "${escapeHtml(searchQuery)}"` : `/files/${escapeHtml(prefix)}`}</h1>
    </div>
    <div class="search-wrap">
      <form method="GET" action="/" class="search-form" onsubmit="return false;">
        <input type="text" id="search-input" name="q" placeholder="Search files/folders..." value="${escapeHtml(searchQuery || "")}" style="flex:1; background:var(--md-sys-color-surface-variant); border:none; padding:0 24px; height:48px; border-radius:24px; color:white; outline:none; font-family:'Outfit', sans-serif;">
        <a href="/?prefix=${encodeURIComponent(prefix)}" id="clear-search" class="btn btn-tonal clear-search-button" style="${isSearching ? "" : "display:none"}">Clear</a>
      </form>
    </div>
    <div class="actions">
      <span class="role-badge">${isAdmin ? "Admin" : "Viewer"}</span>
      <a class="btn btn-outlined" href="/logout">Logout</a>
    </div>
  </div>

  <div class="storage-card">
    <div class="storage-header">
      <span>Storage Usage</span>
      <span>${formatBytes(storageUsed)} / ${formatBytes(storageLimit)}</span>
    </div>
    <div class="progress-track">
      <div class="progress-bar" style="width: ${storagePercent}%"></div>
    </div>
  </div>

  ${isAdmin ? `
  <div class="admin-tools">
      <form method="POST" action="/upload" enctype="multipart/form-data" class="tool-group admin-row upload-form" id="upload-form">
        <input type="hidden" name="prefix" value="${escapeHtml(prefix)}">
        <input type="file" name="files" id="upload-input" class="upload-input" multiple required>
        <label for="upload-input" class="upload-dropzone" id="upload-dropzone">
          <strong>Drag files here to upload</strong>
          <span>or click to choose files</span>
        </label>
        <div class="upload-controls">
          <button type="submit" class="btn btn-filled">Upload</button>
          <button type="button" class="btn btn-outlined upload-clear" id="clear-upload" style="display:none">Clear</button>
        </div>
        <div class="upload-list" id="upload-list"></div>
        <div class="upload-progress" id="upload-progress">
          <div class="upload-progress-text" id="upload-progress-text"></div>
          <div class="upload-progress-track">
            <div class="upload-progress-bar" id="upload-progress-bar"></div>
          </div>
        </div>
      </form>
      <form method="POST" action="/mkdir" class="tool-group admin-row folder-form">
        <input type="hidden" name="prefix" value="${escapeHtml(prefix)}">
        <input type="text" name="folderName" placeholder="New folder..." required>
        <button type="submit" class="btn btn-tonal">Create Folder</button>
      </form>
  </div>` : ""}

  <div class="card">
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Type</th>
          <th>Size</th>
          <th>Modified</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody id="file-table-body">
        ${rows || `<tr><td colspan="5" style="text-align:center;padding:40px;color:var(--md-sys-color-on-surface-variant)">No files found in this directory</td></tr>`}
      </tbody>
    </table>
  </div>

  <div class="footer">
    <div class="visitor-badge">
      <span>Total Visitors: <b>${visitorCount || 0}</b></span>
    </div>
  </div>
</div>

<script>
const ALL_FILES = ${JSON.stringify(allFiles)};
const IS_ADMIN = ${isAdmin};
const USER_ROLE = ${JSON.stringify(userRole)};
const CURRENT_PREFIX = ${JSON.stringify(prefix)};
const APP_ORIGIN = ${JSON.stringify(origin)};
const INITIAL_ROWS = \`${rows.replace(/`/g, "\\`").replace(/\$/g, "\\$")}\`;

const searchInput = document.getElementById('search-input');
const tableBody = document.getElementById('file-table-body');
const clearBtn = document.getElementById('clear-search');
const pathTitle = document.querySelector('.path-container h1');
const uploadInput = document.getElementById('upload-input');
const uploadDropzone = document.getElementById('upload-dropzone');
const uploadList = document.getElementById('upload-list');
const clearUploadBtn = document.getElementById('clear-upload');
const uploadForm = document.getElementById('upload-form');
const uploadProgress = document.getElementById('upload-progress');
const uploadProgressText = document.getElementById('upload-progress-text');
const uploadProgressBar = document.getElementById('upload-progress-bar');
let isUploading = false;
const UPLOAD_CONCURRENCY = 3;

function resetSearch() {
  searchInput.value = '';
  tableBody.innerHTML = INITIAL_ROWS;
  clearBtn.style.display = 'none';
  pathTitle.innerText = '/files/' + CURRENT_PREFIX;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const sizes = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(1)) + " " + sizes[i];
}

function getIcon(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  if (['png','jpg','jpeg','gif','webp','svg'].includes(ext)) return "🖼️";
  if (['mp4','webm','mov','mkv'].includes(ext)) return "🎬";
  if (['mp3','wav','flac','ogg'].includes(ext)) return "🎵";
  if (['zip','rar','7z'].includes(ext)) return "📦";
  return "📄";
}

function getFileType(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  const map = {
    png: "Image PNG", jpg: "Image JPG", jpeg: "Image JPEG", zip: "Archive ZIP",
    pdf: "Document PDF", txt: "Text Files", js: "Code JS", html: "Code HTML"
  };
  return map[ext] || "File " + ext.toUpperCase();
}

function isPreviewable(filename) {
  return /\.(png|jpg|jpeg|gif|webp|svg|mp4|webm|mov|mkv|txt)$/i.test(filename);
}

function objectUrl(key, download) {
  const url = new URL('/' + String(key).split('/').map(encodeURIComponent).join('/'), APP_ORIGIN || window.location.origin);
  if (download) url.searchParams.set('download', '1');
  return url.toString();
}

searchInput.addEventListener('input', (e) => {
  const q = e.target.value.toLowerCase().trim();
  
  if (!q) {
    resetSearch();
    return;
  }

  clearBtn.style.display = 'inline-flex';
  pathTitle.innerText = 'Search: "' + q + '"';

  const filtered = ALL_FILES.filter(f => f.key.toLowerCase().includes(q)).slice(0, 100);
  
  if (filtered.length === 0) {
    tableBody.innerHTML = '<tr><td colspan="5" style="text-align:center;padding:40px;color:var(--md-sys-color-on-surface-variant)">No matching files found</td></tr>';
    return;
  }

  tableBody.innerHTML = filtered.map(f => {
    const isFolder = f.key.endsWith('/') && f.size === 0;
    const previewable = isPreviewable(f.key);
    
    return \`
<tr>
  <td>
    <a class="file-link" href="\${objectUrl(f.key)}" \${previewable ? 'target="_blank"' : ''}>
      <span class="icon">\${isFolder ? '📁' : getIcon(f.key)}</span>\${f.key}
    </a>
  </td>
  <td><span class="type-badge">\${isFolder ? 'Folder' : getFileType(f.key)}</span></td>
  <td>\${isFolder ? '-' : formatBytes(f.size)}</td>
  <td>\${new Date(f.uploaded).toLocaleString()}</td>
  <td>
    <div class="file-actions">
      \${isFolder ? \`<a class="btn btn-tonal" href="/?prefix=\${encodeURIComponent(f.key)}">Open</a>\` : \`
        \${previewable ? \`<a class="btn btn-tonal" href="\${objectUrl(f.key)}" target="_blank">Preview</a>\` : ''}
        <a class="btn btn-outlined" href="\${objectUrl(f.key, true)}">Download</a>
      \`}
      \${IS_ADMIN ? \`
      <form method="POST" action="/delete" onsubmit="return confirm('Hapus \${isFolder ? 'folder' : 'file'} ini?')">
        <input type="hidden" name="key" value="\${f.key}">
        <input type="hidden" name="prefix" value="\${CURRENT_PREFIX}">
        <button type="submit" class="btn btn-outlined btn-danger" style="color:var(--md-sys-color-error); border-color:var(--md-sys-color-error)">Delete</button>
      </form>\` : ''}
    </div>
  </td>
</tr>\`;
  }).join('');
});

clearBtn.addEventListener('click', (e) => {
  e.preventDefault();
  resetSearch();
  searchInput.focus();
});

function renderUploadList() {
  if (!uploadInput || !uploadList || !clearUploadBtn) return;

  const files = Array.from(uploadInput.files || []);
  uploadList.innerHTML = '';
  uploadList.classList.toggle('has-files', files.length > 0);
  clearUploadBtn.style.display = files.length > 0 ? 'inline-flex' : 'none';

  if (files.length > 0) {
    const chip = document.createElement('span');
    chip.className = 'upload-chip';
    chip.textContent = files.length + (files.length === 1 ? ' file selected' : ' files selected');
    uploadList.appendChild(chip);
  }
}

function setUploadFiles(files) {
  if (!uploadInput) return;

  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  uploadInput.files = transfer.files;
  renderUploadList();
}

if (uploadInput && uploadDropzone) {
  uploadInput.addEventListener('change', renderUploadList);

  for (const eventName of ['dragenter', 'dragover']) {
    uploadDropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      uploadDropzone.classList.add('is-dragging');
    });
  }

  for (const eventName of ['dragleave', 'drop']) {
    uploadDropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      uploadDropzone.classList.remove('is-dragging');
    });
  }

  uploadDropzone.addEventListener('drop', (e) => {
    setUploadFiles(e.dataTransfer.files);
  });
}

if (clearUploadBtn && uploadInput) {
  clearUploadBtn.addEventListener('click', () => {
    uploadInput.value = '';
    renderUploadList();
  });
}

if (uploadForm) {
  uploadForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (isUploading || !uploadInput) return;

    const files = Array.from(uploadInput.files || []);
    if (files.length === 0) return;

    const submitButton = uploadForm.querySelector('button[type="submit"]');
    if (!submitButton) return;

    const originalLabel = submitButton.textContent || 'Upload';
    const prefixInput = uploadForm.querySelector('input[name="prefix"]');
    const prefixValue = prefixInput ? prefixInput.value : '';
    const totalBytes = files.reduce((sum, file) => sum + (file.size || 0), 0);
    const progressByIndex = files.map(() => 0);
    let completedCount = 0;

    const renderProgress = () => {
      const uploadedBytes = progressByIndex.reduce((sum, value) => sum + value, 0);
      const percent = totalBytes > 0 ? Math.min((uploadedBytes / totalBytes) * 100, 100) : 0;
      if (uploadProgress && uploadProgressText && uploadProgressBar) {
        uploadProgress.classList.add('is-active');
        uploadProgressBar.style.width = percent.toFixed(2) + '%';
        uploadProgressText.textContent = 'Uploading ' + completedCount + '/' + files.length + ' files - ' + percent.toFixed(1) + '%';
      }
    };

    const uploadViaXhr = (url, method, headers, file, index) => new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method || 'PUT', url);
      for (const [headerKey, headerValue] of Object.entries(headers || {})) {
        xhr.setRequestHeader(headerKey, headerValue);
      }

      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        progressByIndex[index] = event.loaded;
        renderProgress();
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          progressByIndex[index] = file.size || progressByIndex[index];
          completedCount += 1;
          renderProgress();
          resolve();
          return;
        }
        reject(new Error(xhr.responseText || 'Upload error'));
      };

      xhr.onerror = () => reject(new Error('Network upload error'));
      xhr.send(file);
    });

    isUploading = true;
    submitButton.disabled = true;
    clearUploadBtn.style.display = 'none';
    submitButton.textContent = 'Uploading...';
    renderProgress();

    try {
      let cursor = 0;
      const workers = Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, async () => {
        while (cursor < files.length) {
          const index = cursor++;
          const file = files[index];
          const presign = await fetch('/upload-presign', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({
              filename: file.name,
              prefix: prefixValue,
              contentType: file.type || 'application/octet-stream'
            })
          });

          if (!presign.ok) {
            const errText = await presign.text().catch(() => 'Presign error');
            throw new Error(errText || 'Presign error');
          }

          const signed = await presign.json();
          await uploadViaXhr(
            signed.url,
            signed.method || 'PUT',
            signed.headers || { 'Content-Type': file.type || 'application/octet-stream' },
            file,
            index
          );
        }
      });

      await Promise.all(workers);

      window.location.href = '/?prefix=' + encodeURIComponent(prefixValue);
    } catch (err) {
      alert('Upload gagal: ' + (err && err.message ? err.message : 'Unknown error'));
    } finally {
      isUploading = false;
      submitButton.disabled = false;
      submitButton.textContent = originalLabel;
      if (uploadProgress) uploadProgress.classList.remove('is-active');
      if (uploadProgressBar) uploadProgressBar.style.width = '0%';
      if (uploadProgressText) uploadProgressText.textContent = '';
      if (uploadInput && uploadInput.files && uploadInput.files.length > 0) {
        clearUploadBtn.style.display = 'inline-flex';
      }
    }
  });
}
</script>
</body>
</html>`;
}

function loginPage(error) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Login — File Manager</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
* { box-sizing: border-box; }
:root {
  --md-sys-color-primary: #D0BCFF;
  --md-sys-color-on-primary: #381E72;
  --md-sys-color-surface: #1C1B1F;
  --md-sys-color-surface-variant: #49454F;
  --md-sys-color-background: #141218;
  --md-sys-color-on-surface: #E6E1E5;
  --md-sys-color-outline: #938F99;
}
body {
  margin: 0;
  background: var(--md-sys-color-background);
  color: var(--md-sys-color-on-surface);
  font-family: 'Outfit', sans-serif;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 20px;
}
.login-card {
  background: var(--md-sys-color-surface);
  padding: 40px;
  border-radius: 28px;
  width: 100%;
  max-width: 400px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.4);
}
h2 { margin: 0 0 8px; font-size: 32px; font-weight: 600; }
p { color: #9ca3af; margin-bottom: 24px; }
input {
  width: 100%;
  padding: 16px;
  margin-bottom: 16px;
  background: var(--md-sys-color-surface-variant);
  border: 1px solid var(--md-sys-color-outline);
  border-radius: 12px;
  color: var(--md-sys-color-on-surface);
  font-family: 'Outfit', sans-serif;
  font-size: 16px;
  outline: none;
  transition: border-color 0.2s;
}
input:focus { border-color: var(--md-sys-color-primary); background: rgba(208,188,255,0.05); }

/* Prevent autofill white background */
input:-webkit-autofill,
input:-webkit-autofill:hover,
input:-webkit-autofill:focus {
  -webkit-text-fill-color: var(--md-sys-color-on-surface);
  -webkit-box-shadow: 0 0 0px 1000px var(--md-sys-color-surface-variant) inset;
  transition: background-color 5000s ease-in-out 0s;
}
button {
  width: 100%;
  padding: 16px;
  background: var(--md-sys-color-primary);
  color: var(--md-sys-color-on-primary);
  border: none;
  border-radius: 100px;
  font-weight: 600;
  font-size: 16px;
  cursor: pointer;
  margin-top: 8px;
  transition: transform 0.1s;
}
button:active { transform: scale(0.98); }
.error { color: #F2B8B5; background: rgba(242,184,181,0.1); padding: 12px; border-radius: 12px; margin-bottom: 16px; text-align: center; }
.back { display: block; text-align: center; margin-top: 24px; color: var(--md-sys-color-primary); text-decoration: none; font-size: 14px; }

@media (max-width: 480px) {
  .login-card {
    padding: 28px 22px;
    border-radius: 24px;
  }

  h2 {
    font-size: 28px;
  }
}
</style>
</head>
<body>
<div class="login-card">
  <h2>Login</h2>
  <p>Login to See files.</p>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
  <form method="POST" action="/login">
    <input name="username" placeholder="Username" required>
    <input name="password" type="password" placeholder="Password" required>
    <button type="submit">Continue</button>
  </form>
  <a class="back" href="/">← Back to files</a>
</div>
</body>
</html>`;
}

function editPage(key, content) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Edit — ${escapeHtml(key)}</title>
<link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600&family=Roboto+Mono&display=swap" rel="stylesheet">
<style>
* { box-sizing: border-box; }
:root {
  --md-sys-color-primary: #D0BCFF;
  --md-sys-color-background: #141218;
  --md-sys-color-surface: #1C1B1F;
  --md-sys-color-on-surface: #E6E1E5;
  --md-sys-color-outline: #938F99;
}
body {
  margin: 0;
  background: var(--md-sys-color-background);
  color: var(--md-sys-color-on-surface);
  font-family: 'Outfit', sans-serif;
  padding: 40px 20px;
}
.editor-container { max-width: 1000px; margin: 0 auto; }
h2 { margin-bottom: 24px; font-weight: 500; }
textarea {
  width: 100%;
  height: 60vh;
  background: #000;
  color: #fff;
  border: 1px solid var(--md-sys-color-outline);
  border-radius: 16px;
  padding: 24px;
  font-family: 'Roboto Mono', monospace;
  font-size: 15px;
  line-height: 1.6;
  outline: none;
  resize: vertical;
}
.actions { margin-top: 24px; display: flex; gap: 12px; }
.btn {
  padding: 12px 32px;
  border-radius: 24px;
  border: none;
  font-weight: 600;
  cursor: pointer;
  text-decoration: none;
}
.btn-save { background: var(--md-sys-color-primary); color: #381E72; }
.btn-cancel { background: transparent; border: 1px solid var(--md-sys-color-outline); color: #fff; }

@media (max-width: 600px) {
  body {
    padding: 24px 12px;
  }

  h2 {
    font-size: 20px;
    overflow-wrap: anywhere;
  }

  textarea {
    height: 58vh;
    padding: 16px;
    font-size: 14px;
  }

  .actions {
    flex-direction: column;
  }

  .btn {
    width: 100%;
    text-align: center;
  }
}
</style>
</head>
<body>
<div class="editor-container">
  <h2>Editing: ${escapeHtml(key)}</h2>
  <form method="POST">
    <textarea name="content">${escapeHtml(content)}</textarea>
    <div class="actions">
      <button type="submit" class="btn btn-save">Save changes</button>
      <a href="/?prefix=${encodeURIComponent(getParentPrefix(key))}" class="btn btn-cancel">Cancel</a>
    </div>
  </form>
</div>
</body>
</html>`;
}

function sanitizePrefix(prefix) {
  prefix = String(prefix || "").replace(/^\/+/, "");
  if (prefix && !prefix.endsWith("/")) prefix += "/";
  return prefix;
}

function getParentPrefix(prefix) {
  const parts = prefix.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? parts.join("/") + "/" : "";
}

async function isAdmin(request, env) {
  const session = await getSession(request, env);
  return session?.role === "admin";
}

async function getSession(request, env) {
  if (!env.SECRET_KEY) return null;

  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies = Object.fromEntries(
    cookieHeader
      .split(";")
      .map(c => c.trim())
      .filter(Boolean)
      .map(c => {
        const separator = c.indexOf("=");
        return separator === -1 ? [c, ""] : [c.slice(0, separator), c.slice(separator + 1)];
      })
  );
  const cookieValue = cookies[COOKIE_NAME];

  if (!cookieValue) return null;

  const [payload, signature] = cookieValue.split(".");
  if (!payload || !signature) return null;

  const expectedSignature = await sign(payload, env.SECRET_KEY);
  if (signature !== expectedSignature) return null;

  const [role, expiration, fingerprint] = payload.split(":");
  if (!["admin", "viewer"].includes(role) || Date.now() / 1000 > parseInt(expiration)) return null;

  const expectedFingerprint = await sessionFingerprint(request, env);
  if (fingerprint !== expectedFingerprint) return null;

  return { role };
}

function redirectToLogin(url) {
  const loginUrl = new URL("/login", url.origin);
  return new Response(null, {
    status: 302,
    headers: {
      Location: loginUrl.toString()
    }
  });
}

async function sign(data, secret) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const dataData = encoder.encode(data);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyData,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign("HMAC", cryptoKey, dataData);
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=UTF-8" }
  });
}

function isPreviewable(contentType, filename) {
  return (
    contentType.startsWith("image/") ||
    contentType.startsWith("video/") ||
    contentType === "text/plain" ||
    /\.(png|jpg|jpeg|gif|webp|svg|mp4|webm|mov|mkv|txt)$/i.test(filename)
  );
}

function guessContentType(filename) {
  const ext = filename.toLowerCase().split(".").pop();
  const map = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    mkv: "video/x-matroska",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    flac: "audio/flac",
    ogg: "audio/ogg",
    zip: "application/zip",
    rar: "application/vnd.rar",
    "7z": "application/x-7z-compressed",
    pdf: "application/pdf",
    txt: "text/plain",
    json: "application/json",
    html: "text/html",
    css: "text/css",
    js: "application/javascript"
  };
  return map[ext] || "application/octet-stream";
}

function getFileType(filename) {
  const ext = filename.toLowerCase().split(".").pop();

  const map = {
    png: "Image PNG",
    jpg: "Image JPG",
    jpeg: "Image JPEG",
    gif: "Image GIF",
    webp: "Image WEBP",
    svg: "Image SVG",

    mp4: "Video MP4",
    webm: "Video WEBM",
    mov: "Video MOV",
    mkv: "Video MKV",

    mp3: "Audio MP3",
    wav: "Audio WAV",
    flac: "Audio FLAC",
    ogg: "Audio OGG",

    zip: "Archive ZIP",
    rar: "Archive RAR",
    "7z": "Archive 7Z",
    tar: "Archive TAR",
    gz: "Archive GZ",

    pdf: "Document PDF",
    doc: "Document DOC",
    docx: "Document DOCX",
    xls: "Spreadsheet XLS",
    xlsx: "Spreadsheet XLSX",
    ppt: "Presentation PPT",
    pptx: "Presentation PPTX",

    txt: "Text TXT",
    json: "Code JSON",
    js: "Code JS",
    html: "Code HTML",
    css: "Code CSS",
    php: "Code PHP",
    py: "Code PY",
    java: "Code JAVA",
    cpp: "Code CPP",
    c: "Code C"
  };

  return map[ext] || `File ${ext.toUpperCase()}`;
}

function getIcon(filename) {
  const type = guessContentType(filename);
  if (type.startsWith("image/")) return "🖼️";
  if (type.startsWith("video/")) return "🎬";
  if (type.startsWith("audio/")) return "🎵";
  if (filename.toLowerCase().endsWith(".zip")) return "📦";
  if (filename.toLowerCase().endsWith(".rar")) return "📦";
  if (filename.toLowerCase().endsWith(".7z")) return "📦";
  if (filename.toLowerCase().endsWith(".pdf")) return "📄";
  return "📄";
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const sizes = ["B", "KiB", "MiB", "GiB", "TiB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[c]));
}

async function sessionFingerprint(request, env) {
  const userAgent = request.headers.get("User-Agent") || "";
  const acceptLanguage = request.headers.get("Accept-Language") || "";
  const fingerprintSource = `${userAgent}\n${acceptLanguage}\n${env.SECRET_KEY}`;
  return sha256Url(fingerprintSource);
}

async function sha256Url(data) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function objectUrl(origin, key, download = false) {
  const url = new URL("/" + encodeObjectPath(key), origin);
  if (download) url.searchParams.set("download", "1");
  return url.toString();
}

function encodeObjectPath(key) {
  return String(key)
    .replace(/^\/+/, "")
    .split("/")
    .map(part => encodeURIComponent(part))
    .join("/");
}

function contentDisposition(type, key) {
  const filename = String(key).split("/").pop() || "download";
  const fallback = filename
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_");

  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function encodeR2ObjectKey(key) {
  return String(key)
    .split("/")
    .map(part => encodeURIComponent(part))
    .join("/");
}
