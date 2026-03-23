from typing import List, Dict, Tuple
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

app = FastAPI(title="Voice Chat Signaling Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class ConnectionManager:
    def __init__(self):
        # channel_id -> list of (WebSocket, role)
        self.active_connections: Dict[str, List[Tuple[WebSocket, str]]] = {}

    async def connect(self, websocket: WebSocket, channel_id: str, role: str):
        await websocket.accept()
        if channel_id not in self.active_connections:
            self.active_connections[channel_id] = []
        self.active_connections[channel_id].append((websocket, role))

    def disconnect(self, websocket: WebSocket, channel_id: str):
        if channel_id in self.active_connections:
            self.active_connections[channel_id] = [
                conn for conn in self.active_connections[channel_id] if conn[0] != websocket
            ]
            if not self.active_connections[channel_id]:
                self.active_connections.pop(channel_id, None)

    async def broadcast(self, message: str, channel_id: str, sender: WebSocket):
        if channel_id in self.active_connections:
            for connection, role in self.active_connections[channel_id]:
                if connection != sender:
                    try:
                        await connection.send_text(message)
                    except:
                        pass

    def has_director(self, channel_id: str) -> bool:
        if channel_id in self.active_connections:
            for _, role in self.active_connections[channel_id]:
                if role == "Director":
                    return True
        return False

manager = ConnectionManager()

@app.websocket("/ws/{channel_id}/{role}")
async def websocket_endpoint(websocket: WebSocket, channel_id: str, role: str):
    if role == "Director" and manager.has_director(channel_id):
        await websocket.accept()
        await websocket.send_json({"type": "error", "message": "Ya hay un Director en esta sala."})
        await websocket.close()
        return

    await manager.connect(websocket, channel_id, role)
    try:
        while True:
            data = await websocket.receive_text()
            await manager.broadcast(data, channel_id, websocket)
    except WebSocketDisconnect:
        manager.disconnect(websocket, channel_id)

from fastapi.responses import FileResponse

@app.get("/")
def read_root():
    return FileResponse("cliente_web.html")

@app.get("/logo.png")
def read_logo():
    return FileResponse("logo.png")

@app.get("/channels")
def get_channels():
    # Devuelve la lista de nombres de salas que tienen al menos 1 usuario
    active_channels = [k for k, v in manager.active_connections.items() if len(v) > 0]
    return {"channels": active_channels}

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
