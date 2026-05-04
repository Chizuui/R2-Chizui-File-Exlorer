# Chizui File Explorer

A modern, lightweight file manager built on **Cloudflare Workers**, **R2 Storage**, and **Cloudflare KV**. It provides a sleek, responsive web interface for managing files and folders with ease.

## 🚀 Features

- **File Management**: Upload, download, and delete files with ease.
- **Folder Support**: Create and manage folders (prefixes) to organize your storage.
- **File Search**: Real-time search functionality to find your files quickly.
- **Previews**: Built-in preview support for images, videos, audio, and PDF files.
- **Text Editor**: Edit `.txt` files directly in the browser.
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
   - `USERNAME`: The username for dashboard access.
   - `PASSWORD`: The password for dashboard access.
   - `SECRET_KEY`: A strong random string used for signing authentication cookies.

   You can set these using Wrangler:
   ```bash
   npx wrangler secret put USERNAME
   npx wrangler secret put PASSWORD
   npx wrangler secret put SECRET_KEY
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
   SECRET_KEY=your-secret-key
   ```

## 🚢 Deployment

Deploy the worker to Cloudflare:
```bash
npm run deploy
```

## 📝 License

This project is private and for personal use.
