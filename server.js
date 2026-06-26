const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let players = {};
let bullets = [];
let explosions = []; 

let savedWeaponsByColor = {};

// 障害物（ブロック）データ
let obstacles = [
    { x: 300, y: 200, width: 60, height: 200 },
    { x: 700, y: 400, width: 250, height: 60 },
    { x: 500, y: 100, width: 200, height: 60 }
];

// 爆発の判定処理
function triggerExplosion(ex, ey, ownerId) {
    const explosionRadius = 120; 
    const innerRadius = 45;      

    explosions.push({ x: ex, y: ey, radius: explosionRadius, life: 20, maxLife: 20 });

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
    console.log('プレイヤーが参加しました ID:', socket.id);

    socket.on('player_join', (joinData) => {
        const playerColor = joinData.color;
        if (!savedWeaponsByColor[playerColor]) {
            savedWeaponsByColor[playerColor] = 'machinegun';
        }

        const currentWidth = players[socket.id] ? players[socket.id].stageWidth : 1200;
        const currentHeight = players[socket.id] ? players[socket.id].stageHeight : 800;

        players[socket.id] = {
            x: joinData.x,
            y: joinData.y,
            size: joinData.size,
            color: playerColor,
            hp: joinData.hp,
            maxHp: joinData.maxHp,
            alive: joinData.alive,
            weapon: savedWeaponsByColor[playerColor],
            stageWidth: currentWidth,
            stageHeight: currentHeight
        };

        socket.emit('init_weapon', savedWeaponsByColor[playerColor]);
    });

    socket.on('change_weapon', (data) => {
        savedWeaponsByColor[data.color] = data.weaponType;
        if (players[socket.id]) {
            players[socket.id].weapon = data.weaponType;
        }
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
        
        let speed = 8;
        let life = 120; 
        let damage = 2;
        let isRocket = false; 
        let isSniper = false; // 💡 スナイパー用の識別フラグ

        if (currentWeapon === 'shotgun') {
            speed = 7; life = 18; damage = 8;
        } else if (currentWeapon === 'sniper') {
            speed = 26; 
            life = 100;
            damage = 5;      // 💡 近距離（発射直後）の最低威力を「5」に設定
            isSniper = true;
        } else if (currentWeapon === 'rocket') {
            speed = 7; life = 85; damage = 15; isRocket = true;
        }

        if (currentWeapon === 'shotgun') {
            for (let i = -5; i <= 5; i++) {
                if (i === 0) continue;
                let spreadAngle = bulletData.angle + (i * 0.08);
                bullets.push({
                    ownerId: socket.id, x: bulletData.x, y: bulletData.y,
                    startX: bulletData.x, startY: bulletData.y, // 発射位置を記録
                    vx: Math.cos(spreadAngle) * speed, vy: Math.sin(spreadAngle) * speed,
                    life: life, damage: damage, isRocket: false, isSniper: false
                });
            }
        } else {
            bullets.push({
                ownerId: socket.id, x: bulletData.x, y: bulletData.y,
                startX: bulletData.x, startY: bulletData.y, // 💡 弾が生まれた座標を記録しておく
                vx: Math.cos(bulletData.angle) * speed, vy: Math.sin(bulletData.angle) * speed,
                life: life, damage: damage, isRocket: isRocket, isSniper: isSniper
            });
        }
    });

    socket.on('disconnect', () => {
        console.log('プレイヤーが退室しました ID:', socket.id);
        delete players[socket.id];
    });
});

// サーバー側メインループ
setInterval(() => {
    for (let i = explosions.length - 1; i >= 0; i--) {
        explosions[i].life--;
        if (explosions[i].life <= 0) { explosions.splice(i, 1); }
    }

    for (let i = bullets.length - 1; i >= 0; i--) {
        let b = bullets[i];
        b.x += b.vx;
        b.y += b.vy;
        b.life--;

        let owner = players[b.ownerId];
        let maxWidth = owner && owner.stageWidth ? owner.stageWidth : 2000;
        let maxHeight = owner && owner.stageHeight ? owner.stageHeight : 2000;

        if (b.life <= 0) {
            if (b.isRocket) { triggerExplosion(b.x, b.y, b.ownerId); }
            bullets.splice(i, 1);
            continue;
        }

        if (b.x < 0 || b.x > maxWidth || b.y < 0 || b.y > maxHeight) {
            bullets.splice(i, 1);
            continue;
        }

        // 当たり判定
        let hit = false;
        for (let id in players) {
            let p = players[id];
            if (!p.alive || b.ownerId === id) continue;

            if (b.x >= p.x && b.x <= p.x + p.size &&
                b.y >= p.y && b.y <= p.y + p.size) {
                
                let finalDamage = b.damage;

                // 💡 スナイパーの弾だった場合、進んだ距離に応じて威力を計算する
                if (b.isSniper) {
                    // 発射された場所から、当たった場所までの距離（マス数）を計算
                    let travelDistance = Math.hypot(b.x - b.startX, b.y - b.startY);

                    if (travelDistance < 200) {
                        // ① 近距離（200マス未満）：マシンガンより少し強いだけの「5」ダメージ
                        finalDamage = 5;
                    } else if (travelDistance < 700) {
                        // ② 中距離（200〜500マス）：だんだん威力が上がっていく（最大25ダメージ）
                        // 距離が離れるほど、5から25ダメージへ滑らかに増加
                        let ratio = (travelDistance - 200) / 300;
                        finalDamage = 5 + Math.floor(ratio * 10);
                    } else {
                        // ③ 遠距離（500マス以上）：一撃必殺級の超大ダメージ「45」！！
                        finalDamage = 45;
                    }
                }

                // 決定したダメージを減算
                p.hp -= finalDamage;

                if (b.isRocket) { triggerExplosion(b.x, b.y, b.ownerId); }

                if (p.hp <= 0) {
                    p.hp = 0;
                    p.alive = false;
                }
                bullets.splice(i, 1);
                hit = true;
                break;
            }
        }
        if (hit) continue;
    }

    io.emit('server_update', { players: players, bullets: bullets, obstacles: obstacles, explosions: explosions });
}, 1000 / 60);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`ゲームサーバーがポート ${3000} で起動しました！`);
});