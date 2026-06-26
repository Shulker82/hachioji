const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let players = {};
let bullets = {}; // 💡【軽量化】配列からオブジェクト（連想配列）に変更
let bulletIdCounter = 0; // 弾に一意のIDをつけるためのカウンター

let explosions = []; 
let savedWeaponsByColor = {};

let obstacles = [
    { x: 300, y: 200, width: 60, height: 200 },
    { x: 700, y: 400, width: 250, height: 60 },
    { x: 500, y: 100, width: 200, height: 60 }
];

function triggerExplosion(ex, ey, ownerId) {
    const explosionRadius = 120; 
    const innerRadius = 45;      

    explosions.push({ x: ex, y: ey, radius: explosionRadius, life: 10, maxLife: 10 }); // 💡爆発の寿命も少し短くして負荷軽減

    for (let id in players) {
        let p = players[id];
        if (!p.alive) continue;

        let pCenterX = p.x + p.size / 2;
        let pCenterY = p.y + p.size / 2;
        let dist = Math.hypot(pCenterX - ex, pCenterY - ey);

        if (dist <= innerRadius) {
            p.hp -= 100;
        } else if (dist <= explosionRadius) {
            p.hp -= 25;
        } else {
            continue;
        }

        if (p.hp <= 0) { p.hp = 0; p.alive = false; }
    }
}

io.on('connection', (socket) => {
    socket.on('player_join', (joinData) => {
        const playerColor = joinData.color;
        if (!savedWeaponsByColor[playerColor]) {
            savedWeaponsByColor[playerColor] = 'machinegun';
        }

        players[socket.id] = {
            x: joinData.x, y: joinData.y, size: joinData.size, color: playerColor,
            hp: joinData.hp, maxHp: joinData.maxHp, alive: joinData.alive,
            weapon: savedWeaponsByColor[playerColor],
            stageWidth: 1200, stageHeight: 800
        };
        socket.emit('init_weapon', savedWeaponsByColor[playerColor]);
    });

    socket.on('change_weapon', (data) => {
        savedWeaponsByColor[data.color] = data.weaponType;
        if (players[socket.id]) { players[socket.id].weapon = data.weaponType; }
    });

    socket.on('player_move', (moveData) => {
        if (players[socket.id] && players[socket.id].alive) {
            players[socket.id].x = moveData.x;
            players[socket.id].y = moveData.y;
        }
    });

    socket.on('update_stage_size', (sizeData) => {
        if (players[socket.id]) {
            players[socket.id].stageWidth = sizeData.width;
            players[socket.id].stageHeight = sizeData.height;
        }
    });

    socket.on('shoot', (bulletData) => {
        if (!players[socket.id] || !players[socket.id].alive) return;

        let currentWeapon = players[socket.id].weapon;
        let speed = 8; let life = 120; let damage = 2;
        let isRocket = false; let isSniper = false;

        if (currentWeapon === 'shotgun') {
            speed = 7; life = 18; damage = 8;
        } else if (currentWeapon === 'sniper') {
            speed = 26; life = 200; damage = 5; isSniper = true; // 💡スナイパーの寿命を少し縮めてデータ削減
        } else if (currentWeapon === 'rocket') {
            speed = 7; life = 150; damage = 15; isRocket = true; // 💡ロケランの寿命も少し短縮
        }

        if (currentWeapon === 'shotgun') {
            for (let i = -4; i <= 4; i++) { // 💡散弾を10発から8発に少し間引いて軽量化
                if (i === 0) continue;
                let spreadAngle = bulletData.angle + (i * 0.09);
                let id = bulletIdCounter++;
                bullets[id] = {
                    ownerId: socket.id, x: bulletData.x, y: bulletData.y,
                    startX: bulletData.x, startY: bulletData.y,
                    vx: Math.cos(spreadAngle) * speed, vy: Math.sin(spreadAngle) * speed,
                    life: life, damage: damage, isRocket: false, isSniper: false
                };
            }
        } else {
            let id = bulletIdCounter++;
            bullets[id] = {
                ownerId: socket.id, x: bulletData.x, y: bulletData.y,
                startX: bulletData.x, startY: bulletData.y,
                vx: Math.cos(bulletData.angle) * speed, vy: Math.sin(bulletData.angle) * speed,
                life: life, damage: damage, isRocket: isRocket, isSniper: isSniper
            };
        }
    });

    socket.on('disconnect', () => { delete players[socket.id]; });
});

// 💡【軽量化】メインループの間隔を 1000/60 から 1000/30 (1秒に30回) に変更！
setInterval(() => {
    for (let i = explosions.length - 1; i >= 0; i--) {
        explosions[i].life--;
        if (explosions[i].life <= 0) { explosions.splice(i, 1); }
    }

    // 💡【軽量化】オブジェクトのループ処理に変更（高速化）
    for (let bId in bullets) {
        let b = bullets[bId];
        b.x += b.vx;
        b.y += b.vy;
        b.life--;

        let owner = players[b.ownerId];
        let maxWidth = owner && owner.stageWidth ? owner.stageWidth : 2000;
        let maxHeight = owner && owner.stageHeight ? owner.stageHeight : 2000;

        if (b.life <= 0) {
            if (b.isRocket) { triggerExplosion(b.x, b.y, b.ownerId); }
            delete bullets[bId]; // 💡配列のspliceではなくdeleteで一瞬で消す
            continue;
        }

        if (b.x < 0 || b.x > maxWidth || b.y < 0 || b.y > maxHeight) {
            delete bullets[bId];
            continue;
        }

        let hit = false;
        for (let id in players) {
            let p = players[id];
            if (!p.alive || b.ownerId === id) continue;

            if (b.x >= p.x && b.x <= p.x + p.size &&
                b.y >= p.y && b.y <= p.y + p.size) {
                
                let finalDamage = b.damage;
                if (b.isSniper) {
                    let travelDistance = Math.hypot(b.x - b.startX, b.y - b.startY);
                    if (travelDistance < 200) finalDamage = 5;
                    else if (travelDistance < 600) {
                        finalDamage = 5 + Math.floor(((travelDistance - 200) / 300) * 20);
                    } else finalDamage = 45;
                }

                p.hp -= finalDamage;
                if (b.isRocket) { triggerExplosion(b.x, b.y, b.ownerId); }
                if (p.hp <= 0) { p.hp = 0; p.alive = false; }
                
                delete bullets[bId]; // 💡deleteで消去
                hit = true;
                break;
            }
        }
        if (hit) continue;
    }

    // データを全員に一斉送信
    io.emit('server_update', { players: players, bullets: bullets, obstacles: obstacles, explosions: explosions });
}, 1000 / 30); // 💡 30fps通信

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`軽量化サーバー起動: ポート ${3000}`);
});