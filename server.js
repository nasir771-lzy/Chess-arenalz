const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Chess } = require("chess.js");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
const rooms = new Map();

app.use(express.static("public"));
app.get("/health", (_req, res) => res.json({ ok: true, service: "Chess Arena" }));

function newCode() { return crypto.randomBytes(3).toString("hex").toUpperCase(); }
function safeName(value) {
  const name = String(value || "").trim().replace(/[<>]/g, "").slice(0, 18);
  return name || "Player";
}
function roomState(room) {
  const game = room.game;
  const history = game.history({ verbose: true }).map(m => ({
    san: m.san, color: m.color, from: m.from, to: m.to
  }));
  const status = game.isCheckmate() ? `Checkmate — ${game.turn() === "w" ? "Black" : "White"} wins`
    : game.isStalemate() ? "Draw — stalemate"
    : game.isThreefoldRepetition() ? "Draw — threefold repetition"
    : game.isInsufficientMaterial() ? "Draw — insufficient material"
    : game.isDraw() ? "Draw"
    : `${game.turn() === "w" ? "White" : "Black"} to move${game.isCheck() ? " · Check" : ""}`;
  return {
    code: room.code,
    fen: game.fen(),
    turn: game.turn(),
    history,
    status,
    over: game.isGameOver(),
    check: game.isCheck(),
    players: {
      w: room.players.w ? room.players.w.name : null,
      b: room.players.b ? room.players.b.name : null
    },
    count: Object.values(room.players).filter(Boolean).length,
    legalMoves: game.isGameOver() ? [] : game.moves({ verbose: true }).map(m => ({ from: m.from, to: m.to, san: m.san, promotion: m.promotion || null }))
  };
}
function emitState(room) { io.to(room.code).emit("state", roomState(room)); }
function emitError(socket, message) { socket.emit("app-error", message); }

io.on("connection", socket => {
  socket.on("create-room", ({ name } = {}) => {
    const code = newCode();
    const room = { code, game: new Chess(), players: { w: { id: socket.id, name: safeName(name) }, b: null }, createdAt: Date.now() };
    rooms.set(code, room);
    socket.join(code);
    socket.data.room = code; socket.data.color = "w";
    socket.emit("room-created", { code, color: "w", name: room.players.w.name });
    emitState(room);
  });

  socket.on("join-room", ({ code, name } = {}) => {
    const key = String(code || "").trim().toUpperCase();
    const room = rooms.get(key);
    if (!room) return emitError(socket, "এই রুম পাওয়া যায়নি। কোডটি আবার দেখো।");
    if (room.players.b) return emitError(socket, "এই রুমে ইতিমধ্যে দুইজন খেলোয়াড় আছে।");
    if (room.players.w && room.players.w.id === socket.id) return emitError(socket, "তুমি ইতিমধ্যে এই রুমে আছো।");
    room.players.b = { id: socket.id, name: safeName(name) };
    socket.join(key); socket.data.room = key; socket.data.color = "b";
    socket.emit("room-joined", { code: key, color: "b", name: room.players.b.name });
    emitState(room);
  });

  socket.on("move", ({ from, to, promotion } = {}) => {
    const room = rooms.get(socket.data.room);
    if (!room) return emitError(socket, "আগে একটি ম্যাচ রুম তৈরি করো বা যোগ দাও।");
    const color = socket.data.color;
    if (!room.players.w || !room.players.b) return emitError(socket, "অন্য খেলোয়াড় যোগ দিলে ম্যাচ শুরু হবে।");
    if (!room.players[color] || room.players[color].id !== socket.id) return emitError(socket, "এই রুমের খেলোয়াড় হিসেবে তোমার পরিচয় পাওয়া যায়নি।");
    if (room.game.isGameOver()) return emitError(socket, "এই ম্যাচ শেষ হয়েছে। নতুন ম্যাচ শুরু করো।");
    if (room.game.turn() !== color) return emitError(socket, "এখন প্রতিপক্ষের চাল।");
    try {
      const move = room.game.move({ from, to, promotion: promotion || "q" });
      if (!move) return emitError(socket, "এই চালটি বৈধ নয়।");
    } catch (_e) { return emitError(socket, "এই চালটি বৈধ নয়।"); }
    emitState(room);
  });

  socket.on("new-game", () => {
    const room = rooms.get(socket.data.room);
    if (!room) return emitError(socket, "কোনো সক্রিয় রুম নেই।");
    if (!room.players.w || !room.players.b) return emitError(socket, "নতুন ম্যাচের আগে দুইজন খেলোয়াড় প্রয়োজন।");
    room.game = new Chess();
    emitState(room);
  });

  socket.on("leave-room", () => leave(socket));
  socket.on("disconnect", () => leave(socket));
});
function leave(socket) {
  const code = socket.data.room;
  if (!code) return;
  const room = rooms.get(code);
  socket.leave(code);
  if (room) {
    if (room.players.w && room.players.w.id === socket.id) room.players.w = null;
    if (room.players.b && room.players.b.id === socket.id) room.players.b = null;
    if (!room.players.w && !room.players.b) rooms.delete(code);
    else {
      io.to(code).emit("opponent-left", "প্রতিপক্ষ সংযোগ বিচ্ছিন্ন করেছে। রুমে আবার যোগ দিতে নতুন কোড ব্যবহার করতে হতে পারে।");
      emitState(room);
    }
  }
  socket.data.room = null; socket.data.color = null;
}
server.listen(PORT, () => console.log(`Chess Arena running on http://localhost:${PORT}`));
