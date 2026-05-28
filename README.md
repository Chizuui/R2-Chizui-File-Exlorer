# Chizui File Explorer

A modern, lightweight file manager built on **Cloudflare Workers**, **R2 Storage**, and **Cloudflare KV**. It provides a sleek, responsive web interface for managing files and folders with ease.

## 🚀 Features

- **Folder Upload & Preservation**: Select entire folders to upload or simply drag-and-drop folders recursively. Folder tree structures are preserved flawlessly in R2.
- **Fast Upload Path**: Browser uploads directly to R2 using presigned URLs for better throughput.
- **Parallel Uploads + Progress**: Multi-file upload with parallel workers and real-time progress bar.
- **Advanced Interactive Sorting**: Clicking columns **Name** or **Modified** dynamically sorts items (ascending or descending) with folders kept elegantly grouped at the top.
- **In-Memory Folder Stats**: Size and modification dates of folders are calculated instantly **in memory** from existing metadata, preventing R2 API overload completely.
- **Code & Script Editor + Previews**: Preview and edit common file formats directly in your browser. Fully supports: `.txt`, `.json`, `.bat`, `.ps1`, `.py`, `.js`, `.ts`, `.css`, `.html`, `.sh`, `.yml`, `.yaml`, `.ini`, `.conf`, `.md`, `.xml`, and `.jsonc`.
- **Google Material Symbols Design**: Sleek UI modernization featuring vector Google Material Symbols instead of standard emojis.
- **Secure Access**: Authentication system using HMAC-signed cookies for secure sessions.
- **Storage Insights**: Real-time storage usage tracking and progress bar.
- **Visitor Analytics**: Integrated visitor counter using Cloudflare KV.
- **Responsive Design**: Premium dark-mode UI inspired by Material Design 3, fully optimized for both desktop and mobile.

## 🛠️ Prerequisites

- [Node.js](https://nodejs.org/) and npm installed.
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) configured with your Cloudflare account.
- A Cloudflare R2 Bucket created.
- A Cloudflare KV Namespace created.

## ⚙️ Configuration

1. **Bucket & KV Bindings**:
   Update `wrangler.jsonc` with your R2 bucket name and KV namespace ID:

   ```jsonc
   "r2_buckets": [
     {
       "binding": "BUCKET",
       "bucket_name": "your-bucket-name"
     }
   ],
   "kv_namespaces": [
     {
       "binding": "STATS",
       "id": "your-kv-namespace-id"
     }
   ]
   ```

2. **Environment Variables**:
   Set the following secrets in your Cloudflare Worker environment:
   - `USERNAME`: The admin username for upload/edit/delete access.
   - `PASSWORD`: The admin password for upload/edit/delete access.
   - `VIEWER_USERNAME`: The viewer username for preview/download access.
   - `VIEWER_PASSWORD`: The viewer password for preview/download access.
   - `SECRET_KEY`: A strong random string used for signing authentication cookies.
   - `R2_ACCOUNT_ID`: Your Cloudflare account ID.
   - `R2_ACCESS_KEY_ID`: R2 S3 API access key ID.
   - `R2_SECRET_ACCESS_KEY`: R2 S3 API secret access key.
   - `R2_BUCKET_NAME` (optional): Bucket name used for presigned upload (defaults to `chizui-files` in code).

   You can set these using Wrangler:

   ```bash
   npx wrangler secret put USERNAME
   npx wrangler secret put PASSWORD
   npx wrangler secret put VIEWER_USERNAME
   npx wrangler secret put VIEWER_PASSWORD
   npx wrangler secret put SECRET_KEY
   npx wrangler secret put R2_ACCOUNT_ID
   npx wrangler secret put R2_ACCESS_KEY_ID
   npx wrangler secret put R2_SECRET_ACCESS_KEY
   npx wrangler secret put R2_BUCKET_NAME
   ```

3. **R2 CORS Policy (Required for Browser Direct Upload)**:
   In your R2 bucket settings, set a CORS policy like this (adjust your domain):
   ```json
   [
   	{
   		"AllowedOrigins": ["https://files.chizui.dev"],
   		"AllowedMethods": ["GET", "HEAD", "PUT"],
   		"AllowedHeaders": ["*"],
   		"ExposeHeaders": ["ETag"],
   		"MaxAgeSeconds": 3600
   	}
   ]
   ```

## 💻 Local Development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the development server:

   ```bash
   npm run dev
   ```

3. (Optional) Create a `.dev.vars` file for local secrets:
   ```env
   USERNAME=admin
   PASSWORD=yourpassword
   VIEWER_USERNAME=viewer
   VIEWER_PASSWORD=viewerpassword
   SECRET_KEY=your-secret-key
   R2_ACCOUNT_ID=your-account-id
   R2_ACCESS_KEY_ID=your-r2-access-key-id
   R2_SECRET_ACCESS_KEY=your-r2-secret-access-key
   R2_BUCKET_NAME=your-bucket-name
   ```

## 🚢 Deployment

Deploy the worker to Cloudflare:

```bash
npm run deploy
```

## 📝 License

This project is licensed under the MIT License.
