const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});
const path = require('path');

app.use(express.static('public'));

// Health check voor Render
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Game rooms storage
const gameRooms = new Map();

class GameRoom {
    constructor(roomId) {
        this.roomId = roomId;
        this.players = [];
        this.gameState = null;
        this.currentTurn = 0;
    }

    addPlayer(socketId, playerName) {
        if (this.players.length < 2) {
            this.players.push({ socketId, playerName, playerId: this.players.length });
            return true;
        }
        return false;
    }

    removePlayer(socketId) {
        this.players = this.players.filter(p => p.socketId !== socketId);
    }

    isFull() {
        return this.players.length === 2;
    }

    initializeGame() {
        const animals = ['BUFFEL', 'OLIFANT', 'LUIPAARD', 'LEEUW', 'NEUSHOORN'];
        let deck = [];
        
        // 35 Big Five cards (7x5)
        animals.forEach(animal => {
            for (let i = 0; i < 7; i++) {
                deck.push({ type: 'bigfive', animal, color: 'yellow', id: `bf-${animal}-${i}` });
            }
        });

        // 5 combination cards
        const combinations = [
            { animals: ['LUIPAARD', 'BUFFEL'] },
            { animals: ['BUFFEL', 'NEUSHOORN'] },
            { animals: ['LEEUW', 'LUIPAARD'] },
            { animals: ['LEEUW', 'OLIFANT'] },
            { animals: ['OLIFANT', 'NEUSHOORN'] }
        ];
        combinations.forEach((combo, i) => {
            deck.push({ type: 'combination', animals: combo.animals, id: `combo-${i}` });
        });

        // 14 special cards (7x2)
        const specials = ['GIRAFFE', 'BIG_FIVE_SPOTTER', 'IJSBEER', 'ZEBRA', 'AASGIER', 'KAMELEON', 'KROKODIL'];
        specials.forEach(special => {
            for (let i = 0; i < 2; i++) {
                deck.push({ type: 'special', special, color: 'blue', id: `sp-${special}-${i}` });
            }
        });

        // Shuffle
        for (let i = deck.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [deck[i], deck[j]] = [deck[j], deck[i]];
        }

        this.gameState = {
            deck: deck,
            players: this.players.map((p, idx) => ({
                id: idx,
                socketId: p.socketId,
                name: p.playerName,
                hand: [],
                personalStack: deck.splice(0, 8),
                discardPile: [],
                score: 0,
                position: 0
            })),
            playAreas: [
                { id: 0, cards: [], maxSpecials: 2 },
                { id: 1, cards: [], maxSpecials: 2 },
                { id: 2, cards: [], maxSpecials: 2 }
            ],
            discardStack: [],
            currentPlayer: 0,
            turnPhase: 'play',
            winner: null
        };
    }

 getGameStateForPlayer(playerId) {
    // Return game state with hidden opponent stack
    const state = JSON.parse(JSON.stringify(this.gameState));
    state.players.forEach((p, idx) => {
        if (idx !== playerId) {
            // Toon kaart achterkant (55.png) voor tegenstander kaarten
            p.personalStack = p.personalStack.map(() => ({ 
                hidden: true, 
                type: 'back',
                id: 'card-back'
            }));
        }
    });
    return state;
}
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('createRoom', ({ playerName }) => {
        const roomId = Math.random().toString(36).substr(2, 6).toUpperCase();
        const room = new GameRoom(roomId);
        room.addPlayer(socket.id, playerName);
        gameRooms.set(roomId, room);
        
        socket.join(roomId);
        socket.emit('roomCreated', { roomId, playerId: 0 });
        console.log(`Room ${roomId} created by ${playerName}`);
    });

    socket.on('joinRoom', ({ roomId, playerName }) => {
        const room = gameRooms.get(roomId);
        
        if (!room) {
            socket.emit('error', { message: 'Room niet gevonden' });
            return;
        }

        if (room.isFull()) {
            socket.emit('error', { message: 'Room is vol' });
            return;
        }

        const added = room.addPlayer(socket.id, playerName);
        if (added) {
            socket.join(roomId);
            const playerId = room.players.length - 1;
            socket.emit('roomJoined', { roomId, playerId });
            
            if (room.isFull()) {
                room.initializeGame();
                room.players.forEach((player, idx) => {
                    io.to(player.socketId).emit('gameStarted', {
                        gameState: room.getGameStateForPlayer(idx),
                        yourPlayerId: idx
                    });
                });
                console.log(`Game started in room ${roomId}`);
            }
        }
    });

    socket.on('playCard', ({ roomId, playerId, cardId, targetAreaId }) => {
        const room = gameRooms.get(roomId);
        if (!room || !room.gameState) return;

        const player = room.gameState.players[playerId];
        const cardIndex = player.personalStack.findIndex(c => c.id === cardId);
        
        if (cardIndex === -1 || room.gameState.currentPlayer !== playerId) {
            socket.emit('error', { message: 'Ongeldige actie' });
            return;
        }

        const card = player.personalStack[cardIndex];
        const targetArea = room.gameState.playAreas.find(a => a.id === targetAreaId);

        if (targetArea) {
            targetArea.cards.push(card);
            player.personalStack.splice(cardIndex, 1);

            if (targetArea.cards.length === 5) {
                const animals = targetArea.cards.map(c => c.animal || c.animals).flat();
                const uniqueAnimals = [...new Set(animals)];
                if (uniqueAnimals.length === 5) {
                    player.score += 3;
                    player.position += 3;
                    targetArea.cards = [];
                }
            }

            room.gameState.currentPlayer = (room.gameState.currentPlayer + 1) % 2;

            if (player.personalStack.length === 0 || player.position >= 10) {
                room.gameState.winner = playerId;
            }

            room.players.forEach((p, idx) => {
                io.to(p.socketId).emit('gameStateUpdated', {
                    gameState: room.getGameStateForPlayer(idx)
                });
            });
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        gameRooms.forEach((room, roomId) => {
            const playerIndex = room.players.findIndex(p => p.socketId === socket.id);
            if (playerIndex !== -1) {
                room.removePlayer(socket.id);
                
                room.players.forEach(p => {
                    io.to(p.socketId).emit('playerDisconnected', {
                        message: 'Tegenstander heeft de verbinding verbroken'
                    });
                });

                if (room.players.length === 0) {
                    gameRooms.delete(roomId);
                }
            }
        });
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`Server draait op poort ${PORT}`);
});
