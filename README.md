# SheetFusion

A powerful, privacy-focused tool to merge multiple spreadsheets that share different common columns. Perfect for reconciling data across multiple sources without compromising data security.

## Features

- **Flexible Matching**: Merge files based on any common column (e.g., File 1 & File 2 match on "Name", File 1 & File 3 match on "Registration No.")
- **Automatic Detection**: SheetFusion automatically identifies matching column names between files and creates connections
- **Dual Output**: Generates both a merged dataset and a mismatches report for easy reconciliation
- **Privacy-First**: No database, no disk writes — all processing happens in memory
- **Case & Whitespace Insensitive**: Smart matching that handles formatting variations
- **Conflict Detection**: Identifies records where matched files disagree on values
- **Incomplete Record Tracking**: Flags records missing from one or more files

## Output Files

1. **merged-data.xlsx** — One row per record, combining columns from every file that matched
2. **mismatches.xlsx** — Records that are missing from one or more files, or where matched files disagree on a value

## Privacy & Security

SheetFusion is designed with privacy as a core principle:

- **No Database**: No persistent storage of any kind
- **No Disk Writes**: Uploaded files are parsed in server memory only
- **Ephemeral Processing**: File buffers are discarded immediately after the response is sent
- **Minimal Logging**: Request logs only record HTTP method, path, and status code — never filenames or file contents
- **Secure Dependencies**: Uses `exceljs` instead of vulnerable `xlsx`/SheetJS package

## Requirements

- Node.js 16 or higher
- npm or yarn

## Installation

```bash
cd server
npm install
```

## Running the Application

### Development Mode

```bash
cd server
npm run dev
```

This runs the server with auto-reload on file changes.

### Production Mode

```bash
cd server
npm start
```

The application will be available at **http://localhost:3000**

### Custom Port

Set the `PORT` environment variable:

```bash
PORT=4000 npm start
```

Or on Windows:

```powershell
$env:PORT=4000; npm start
```

## Project Structure

```
SheetFusion/
├── server/              Express backend (API + serves the frontend)
│   ├── index.js         Main server entry point
│   ├── lib/
│   │   ├── excel.js            Parse/build .xlsx & .csv buffers
│   │   └── reconcileEngine.js  Matching/merging logic
│   ├── package.json
│   └── .gitignore
└── public/              Frontend (plain HTML/CSS/JS, no build step)
    ├── index.html
    ├── style.css
    └── app.js
```

## How It Works

### Step-by-Step Guide

1. **Upload Files**: Upload any number of `.xlsx` or `.csv` files (up to 20 files, 25MB each)
2. **Column Detection**: Each file is parsed (first sheet only) and detected columns are displayed
3. **Auto-Matching**: SheetFusion automatically detects matching column names between files
4. **Merge**: Click **Merge files** to process the data
5. **Download**: Download both the merged file and the mismatches file

### Matching Logic

- **Case-Insensitive**: "Name", "name", and "NAME" are treated as the same column
- **Whitespace-Insensitive**: "First Name" and "FirstName" will match
- **Multi-Column Support**: Different file pairs can match on different columns

### Record Status

- **Complete**: Record found in all uploaded files with no conflicts
- **Incomplete**: Record missing from one or more files
- **Conflict**: Two files that matched on your pinned column disagree on a shared column value (e.g., both have "Department" with different values for the same person)

## Supported File Formats

- **.xlsx** (Excel 2007+)
- **.csv** (Comma-separated values)

**Note**: Legacy `.xls` (pre-2007 binary format) is not supported. Convert to `.xlsx` first using Excel.

## Configuration

### File Limits

Edit `server/index.js` to adjust:

- `MAX_FILE_SIZE`: Maximum file size per upload (default: 25MB)
- `MAX_FILES`: Maximum number of files per request (default: 20)

### Environment Variables

- `PORT`: Server port (default: 3000)

## Dependencies & Security

The backend uses `exceljs` for parsing/writing spreadsheets instead of the `xlsx`/SheetJS package, which has an unpatched high-severity advisory with no fix published to the registry.

The `package.json` includes an `overrides` entry for `uuid` (a transitive dependency of `exceljs`) to ensure a patched version is used.

Run `npm audit` to verify security — it should report 0 vulnerabilities.

## Development

### Adding New Features

The codebase is structured for easy modification:

- **`server/lib/excel.js`**: File parsing and Excel generation logic
- **`server/lib/reconcileEngine.js`**: Core matching and merging algorithms
- **`server/index.js`**: Express server and API endpoints
- **`public/app.js`**: Frontend logic and UI interactions
- **`public/style.css`**: Styling

### Testing

To test changes:

1. Run `npm run dev` for auto-reload
2. Open http://localhost:3000
3. Upload test files and verify the merge behavior

## Production Deployment

### Important Considerations

- **Authentication**: The application has no built-in authentication. Deploy behind an authentication layer (e.g., OAuth, reverse proxy with auth) if making it publicly accessible
- **HTTPS**: Use HTTPS in production to secure data in transit
- **Rate Limiting**: Consider adding rate limiting to prevent abuse
- **Monitoring**: Add application monitoring for production use
- **Reverse Proxy**: Use nginx or Apache as a reverse proxy for better performance and security

### Example Deployment (PM2)

```bash
npm install -g pm2
cd server
pm2 start index.js --name sheetfusion
pm2 save
pm2 startup
```

### Example Deployment (Docker)

Create a `Dockerfile`:

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY server/package*.json ./
RUN npm install --production
COPY server ./server
COPY public ./public
EXPOSE 3000
CMD ["node", "server/index.js"]
```

Build and run:

```bash
docker build -t sheetfusion .
docker run -p 3000:3000 sheetfusion
```

## Troubleshooting

### Files Not Uploading

- Check file size (max 25MB per file)
- Verify file format (.xlsx or .csv only)
- Ensure you're not exceeding the 20 file limit

### Merge Not Working

- Verify that files have at least one common column name
- Check that column names match (case and whitespace insensitive)
- Ensure files have data in the first sheet

### Port Already in Use

```bash
# Find the process using port 3000
netstat -ano | findstr :3000  
# Kill the process or use a different port
PORT=4000 npm start
```

### Memory Issues with Large Files

If you encounter memory errors with large datasets:
- Reduce the number of files per request
- Increase Node.js memory limit: `node --max-old-space-size=4096 server/index.js`

