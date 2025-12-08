# RAG Service (TypeScript)

Standalone microservice for document chunking, embedding generation, and context retrieval.

## Features

- Document upload and processing
- Text chunking with configurable overlap
- Vector embeddings generation using Transformers.js (all-MiniLM-L6-v2)
- Dual storage: PostgreSQL (metadata) + Elasticsearch (vectors)
- Hybrid search (keyword + semantic)
- Context retrieval for chat systems
- **Full TypeScript** with type safety

## Architecture

```
RAG Service (Port 3001)
├── Document Processing
│   ├── Upload & Extract
│   ├── Chunking
│   └── Embedding Generation
├── Storage
│   ├── PostgreSQL (metadata)
│   └── Elasticsearch (vectors)
└── Retrieval
    ├── Text Search
    ├── Vector Search
    └── Hybrid Search
```

## Tech Stack

- **TypeScript** 5.3+
- **Node.js** 18+
- **Express** 5.x
- **PostgreSQL** with PostGIS
- **Elasticsearch** 8.11
- **Transformers.js** for local embeddings (384-dim vectors)

## API Endpoints

### Health Check

- `GET /health` - Service health status

### Documents

- `POST /api/rag/documents/upload` - Upload document
- `GET /api/rag/documents` - List documents
- `GET /api/rag/documents/:id` - Get document details
- `DELETE /api/rag/documents/:id` - Delete document

### Retrieval

- `POST /api/rag/search` - Search knowledge base with filters
- `POST /api/rag/retrieve` - Retrieve context chunks for chat

- `POST /api/query` - Simple query (no session)

## Environment Variables

See `.env.example` for required configuration.

## Running Locally

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your configuration

# Start service
npm start

# Or for development
npm run dev
```

## Running with Docker

```bash
# Build image
docker build -t rag-service .

# Run container
docker run -p 3001:3001 --env-file .env rag-service
```

## Integration

From other services, call RAG endpoints via HTTP:

```javascript
const axios = require("axios");

// Example: Upload document
const formData = new FormData();
formData.append("file", fileBuffer);
formData.append("title", "My Document");

const response = await axios.post("http://rag-service:3001/api/documents/upload", formData, {
  headers: {
    "x-api-key": process.env.RAG_API_KEY,
  },
});

// Example: Chat
const chatResponse = await axios.post(
  "http://rag-service:3001/api/chat",
  {
    message: "What is the safety score?",
    top_k: 5,
  },
  {
    headers: {
      "x-api-key": process.env.RAG_API_KEY,
    },
  }
);
```

## Database Setup

Run migrations in PostgreSQL:

```sql
-- See ../model-vat/migrations/V3_rag_documents.sql
```

## License

MIT
