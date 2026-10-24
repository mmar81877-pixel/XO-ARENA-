const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
app.use(express.static("public"));
app.get("/health", (_, res) => res.json({ ok: true }));

const rooms = new Map();
const scores = new Map();

function safeName(v) { return String(v || "لاعب").replace(/[<>]/g, "").trim().slice(0, 18) || "لاعب"; }
function newCode() {
  let code;
  do { code = crypto.randomBytes(3).toString("hex").slice(0,5).toUpperCase(); } while (rooms.has(code));
  return code;
}
function score(name) {
  if (!scores.has(name)) scores.set(name, {name, wins:0, losses:0, draws:0});
  return scores.get(name);
}
function publicRooms() {
  return [...rooms.values()].filter(r => r.type === "public" && r.players.length < 2)
    .map(r => ({code:r.code, players:r.players.length, status:"بانتظار لاعب"}));
}
function broadcastRooms() { io.emit("public-rooms", publicRooms()); }
function state(r) {
  io.to(r.code).emit("state", {
    code:r.code, type:r.type, board:r.board, turn:r.turn, status:r.status,
    message:r.message, players:r.players.map(p => ({name:p.name, mark:p.mark}))
  });
}
function roomOf(s) { return s.data.roomCode ? rooms.get(s.data.roomCode) : null; }
function judge(b) {
  for (const [a,c,d] of [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]]) {
    if (b[a] && b[a] === b[c] && b[a] === b[d]) return b[a];
  }
  return b.every(Boolean) ? "draw" : null;
}
function create(s, name, type) {
  if (roomOf(s)) return s.emit("notice", "اخرج من الغرفة الحالية أولًا.");
  const code = newCode();
  const r = {code,type,players:[{id:s.id,name:safeName(name),mark:"X"}],
    board:Array(9).fill(""),turn:"X",status:"waiting",message:"في انتظار الخصم… ابعت له الكود"};
  rooms.set(code,r); s.join(code); s.data.roomCode=code;
  s.emit("created",{code,type}); state(r); broadcastRooms();
}
function join(s, code, name, publicOnly=false) {
  if (roomOf(s)) return s.emit("notice", "اخرج من الغرفة الحالية أولًا.");
  const r = rooms.get(String(code||"").toUpperCase());
  if (!r || (publicOnly && r.type!=="public")) return s.emit("notice","الغرفة مش موجودة أو لم تعد متاحة.");
  if (r.players.length >= 2) return s.emit("notice","الغرفة مكتملة.");
  r.players.push({id:s.id,name:safeName(name),mark:"O"});
  s.join(r.code); s.data.roomCode=r.code;
  s.emit("joined",{code:r.code,type:r.type});
  r.board=Array(9).fill(""); r.turn="X"; r.status="playing";
  r.message=`دور ${r.players[0].name} (X)`;
  state(r); broadcastRooms();
}
function leave(s, disconnected=false) {
  const r=roomOf(s);
  if (!r) return;
  s.leave(r.code); s.data.roomCode=null;
  r.players=r.players.filter(p=>p.id!==s.id);
  if (!r.players.length) rooms.delete(r.code);
  else {
    r.status="waiting"; r.board=Array(9).fill(""); r.turn="X";
    r.players[0].mark="X";
    r.message=disconnected ? "انقطع اتصال الخصم. في انتظار لاعب جديد…" : "غادر الخصم. في انتظار لاعب جديد…";
    state(r);
  }
  broadcastRooms();
}
io.on("connection", s => {
  s.emit("public-rooms",publicRooms());
  s.emit("leaderboard",[...scores.values()].sort((a,b)=>b.wins-a.wins).slice(0,10));
  s.on("create", d=>create(s,d?.name,d?.type==="public"?"public":"private"));
  s.on("join", d=>join(s,d?.code,d?.name,false));
  s.on("join-public", d=>join(s,d?.code,d?.name,true));
  s.on("quick", d=>{
    if(roomOf(s)) return s.emit("notice","اخرج من الغرفة الحالية أولًا.");
    const r=[...rooms.values()].find(x=>x.type==="public"&&x.players.length===1&&x.status==="waiting");
    if(r) join(s,r.code,d?.name,true);
    else { create(s,d?.name,"public"); s.emit("notice","أنشأنا غرفة عامة لك؛ في انتظار لاعب آخر."); }
  });
  s.on("move", d=>{
    const r=roomOf(s); if(!r||r.status!=="playing") return;
    const p=r.players.find(x=>x.id===s.id), i=Number(d?.index);
    if(!p||p.mark!==r.turn||!Number.isInteger(i)||i<0||i>8||r.board[i]) return;
    r.board[i]=p.mark;
    const result=judge(r.board);
    if(result){
      r.status="finished";
      if(result==="draw"){r.message="تعادل!";r.players.forEach(p=>score(p.name).draws++);}
      else {
        const winner=r.players.find(p=>p.mark===result), loser=r.players.find(p=>p.mark!==result);
        r.message=`🎉 فاز ${winner.name}!`; score(winner.name).wins++; score(loser.name).losses++;
      }
      state(r);
      io.emit("leaderboard",[...scores.values()].sort((a,b)=>b.wins-a.wins||a.losses-b.losses).slice(0,10));
    } else {
      r.turn=r.turn==="X"?"O":"X";
      r.message=`دور ${r.players.find(p=>p.mark===r.turn).name} (${r.turn})`;
      state(r);
    }
  });
  s.on("again",()=>{
    const r=roomOf(s); if(!r||r.status!=="finished"||r.players.length!==2) return;
    r.board=Array(9).fill("");r.turn="X";r.status="playing";
    r.message=`جولة جديدة! دور ${r.players.find(p=>p.mark==="X").name} (X)`;
    state(r);
  });
  s.on("leave",()=>{leave(s);s.emit("left");});
  s.on("disconnect",()=>leave(s,true));
});
server.listen(PORT,"0.0.0.0",()=>console.log("XO server listening on "+PORT));
