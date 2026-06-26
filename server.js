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

// 💡 爆発の判定処理（超強力版）
function triggerExplosion(ex, ey, ownerId) {
    const explosionRadius = 120; // 💡 爆発全体の巻き込み範囲を少し広く（半径120マス）
    const innerRadius = 45;      // 💡 黄色い爆風（中心付近）の範囲（半径45マス）

    // 画面側のエフェクト用データ（黄色い爆風は0.5倍サイズで描画されているため、innerRadiusとほぼ一致します）
    explosions.push({ x: ex, y: ey, radius: explosionRadius, life: 20, maxLife: 20 });

    for (let id in players) {
        let p = players[id];
        if (!p.alive) continue;

        let pCenterX = p.x + p.size / 2;
        let pCenterY = p.y + p.size / 2;

        // 爆心からの距離を計算
        let dist = Math.hypot(pCenterX - ex, pCenterY - ey);

        if (dist <= innerRadius) {
            // 💡 1. 黄色い爆風（中心の至近距離）に当たった場合は100ダメージ（一撃必殺！）
            p.hp -= 100;
        } else if (dist <= explosionRadius) {
            // 💡 2. オレンジ色の外周爆風に当たった場合は25ダメージ
            p.hp -= 25;
        } else {
            // 範囲外ならダメージなし
            continue;
        }

        // 死亡判定
        if (p.hp <= 0) {
            p.hp = 0;
            p.alive = false;
        }
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

        if (currentWeapon === 'shotgun') {
            speed = 7; life = 18; damage = 8;
        } else if (currentWeapon === 'sniper') {
            speed = 26; life = 100; damage = 30;
        } else if (currentWeapon === 'rocket') {
            // 💡 ロケットランチャーの性能調整
            speed = 7;      // 💡 弾速を少しアップ（5 → 7）
            life = 85;      // 💡 射程（弾の寿命）を大幅に長く（45 → 85）して長距離まで届くように
            damage = 15;    // 直撃時のかすりダメージ（メインは後ろの爆発処理）
            isRocket = true;
        }

        if (currentWeapon === 'shotgun') {
            for (let i = -5; i <= 5; i++) {
                if (i === 0) continue;
                let spreadAngle = bulletData.angle + (i * 0.08);
                bullets.push({
                    ownerId: socket.id, x: bulletData.x, y: bulletData.y,
                    vx: Math.cos(spreadAngle) * speed, vy: Math.sin(spreadAngle) * speed,
                    life: life, damage: damage, isRocket: false
                });
            }
        } else {
            bullets.push({
                ownerId: socket.id, x: bulletData.x, y: bulletData.y,
                vx: Math.cos(bulletData.angle) * speed, vy: Math.sin(bulletData.angle) * speed,
                life: life, damage: damage, isRocket: isRocket
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
        if (explosions[i].life <= 0) {
            explosions.splice(i, 1);
        }
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
            if (b.isRocket) {
                triggerExplosion(b.x, b.y, b.ownerId); 
            }
            bullets.splice(i, 1);
            continue;
        }

        if (b.x < 0 || b.x > maxWidth || b.y < 0 || b.y > maxHeight) {
            bullets.splice(i, 1);
            continue;
        }

        let hit = false;
        for (let id in players) {
            let p = players[id];
            if (!p.alive || b.ownerId === id) continue;

            if (b.x >= p.x && b.x <= p.x + p.size &&
                b.y >= p.y && b.y <= p.y + p.size) {
                
                p.hp -= b.damage;

                if (b.isRocket) {
                    triggerExplosion(b.x, b.y, b.ownerId);
                }

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

// 💡 修正前：server.listen(3000, () => { ... });

// 💡 修正後：Renderなどの環境に対応できるようにポート番号を自動判定にします
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`ゲームサーバーがポート ${PORT} で起動しました！`);
});