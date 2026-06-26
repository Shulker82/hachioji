const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let players = {};
let bullets = [];

// 障害物（ブロック）データ
let obstacles = [
    { x: 300, y: 200, width: 60, height: 200 },
    { x: 700, y: 400, width: 250, height: 60 },
    { x: 500, y: 100, width: 200, height: 60 }
];

io.on('connection', (socket) => {
    console.log('プレイヤーが参加しました ID:', socket.id);

    // 最初の参加 ＆ 復活（respawn）時の処理
    socket.on('player_join', (joinData) => {
        // 既存の画面サイズデータを失わないように保護しつつ、初期化する
        const currentWidth = players[socket.id] ? players[socket.id].stageWidth : 1200;
        const currentHeight = players[socket.id] ? players[socket.id].stageHeight : 800;

        players[socket.id] = {
            x: joinData.x,
            y: joinData.y,
            size: joinData.size,
            color: joinData.color,
            hp: joinData.hp,
            maxHp: joinData.maxHp,
            alive: joinData.alive,
            stageWidth: currentWidth,   // 💡サイズを保護
            stageHeight: currentHeight  // 💡サイズを保護
        };
    });

    // 座標の更新（他の大事なデータを巻き込んで消さないように、xとyだけをピンポイントで上書き）
    socket.on('player_move', (moveData) => {
        if (players[socket.id] && players[socket.id].alive) {
            players[socket.id].x = moveData.x;
            players[socket.id].y = moveData.y;
        }
    });

    // 画面サイズの更新（これによって弾が消える範囲が正しく更新されます）
    socket.on('update_stage_size', (sizeData) => {
        if (players[socket.id]) {
            players[socket.id].stageWidth = sizeData.width;
            players[socket.id].stageHeight = sizeData.height;
        }
    });

    // 弾の発射
    socket.on('shoot', (bulletData) => {
        if (!players[socket.id] || !players[socket.id].alive) return;

        let speed = 8;
        let life = 120; 

        if (bulletData.type === 'shotgun') {
            speed = 6;
            life = 25;  
        } else if (bulletData.type === 'sniper') {
            speed = 22; 
            life = 100;
        }

        bullets.push({
            ownerId: socket.id,
            x: bulletData.x,
            y: bulletData.y,
            vx: Math.cos(bulletData.angle) * speed,
            vy: Math.sin(bulletData.angle) * speed,
            life: life
        });
    });

    socket.on('disconnect', () => {
        console.log('プレイヤーが退室しました ID:', socket.id);
        delete players[socket.id];
    });
});

// サーバー側メインループ（1秒間に60回）
setInterval(() => {
    for (let i = bullets.length - 1; i >= 0; i--) {
        let b = bullets[i];
        b.x += b.vx;
        b.y += b.vy;

        b.life--;
        let owner = players[b.ownerId];
        
        // 💡 弾を撃ったプレイヤーの画面サイズを取得（存在しない場合は安全のために広い数値をデフォルトに）
        let maxWidth = owner && owner.stageWidth ? owner.stageWidth : window.innerWidth || 2000;
        let maxHeight = owner && owner.stageHeight ? owner.stageHeight : window.innerHeight || 2000;

        // 寿命切れ、または正しく取得された画面外で弾を消去
        if (b.life <= 0 || b.x < 0 || b.x > maxWidth || b.y < 0 || b.y > maxHeight) {
            bullets.splice(i, 1);
            continue;
        }

        // 当たり判定
        for (let id in players) {
            let p = players[id];
            if (!p.alive || b.ownerId === id) continue;

            if (b.x >= p.x && b.x <= p.x + p.size &&
                b.y >= p.y && b.y <= p.y + p.size) {
                
                p.hp -= 1; // 1ダメージ

                if (p.hp <= 0) {
                    p.hp = 0;
                    p.alive = false;
                }

                bullets.splice(i, 1);
                break;
            }
        }
    }

    io.emit('server_update', { players: players, bullets: bullets, obstacles: obstacles });
}, 1000 / 60);

server.listen(3000, () => {
    console.log('バグ修正版ゲームサーバー起動！ http://localhost:3000');
});