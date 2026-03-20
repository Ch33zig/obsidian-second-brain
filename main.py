"""Entry point – starts the Second Brain FastAPI server."""
import os
import uvicorn

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8765))
    uvicorn.run("server:app", host="127.0.0.1", port=port, reload=False)
