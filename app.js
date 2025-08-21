const express = require('express')
const socket = require('socket.io')
const http = require('http')
const { Chess } = require('chess.js')
const path = require('path')

const app = express()
const server = http.createServer(app)
const io = socket(server)

const chess = new Chess()

// Track the two player sockets
const players = { white: null, black: null }

app.set('view engine', 'ejs')
app.set('views', path.join(__dirname, 'views'))
app.use(express.static(path.join(__dirname, 'public')))

app.get('/', (req, res) => {
  res.render('index', { title: 'Chess Game' })
})

function getOpponentId(id) {
  if (players.white === id) return players.black
  if (players.black === id) return players.white
  return null
}

io.on('connection', (sock) => {
  console.log('connected:', sock.id)

  // Assign roles
  if (!players.white) {
    players.white = sock.id
    sock.emit('playerrole', 'w')
  } else if (!players.black) {
    players.black = sock.id
    sock.emit('playerrole', 'b')
  } else {
    sock.emit('spectator')
  }

  // Always send current board
  sock.emit('boardstate', chess.fen())

  // If both players present, signal to start the call
  if (players.white && players.black) {
    io.to(players.white).emit('start-call', { peerId: players.black })
    io.to(players.black).emit('start-call', { peerId: players.white })
  }

  // Handle chess moves (turn enforcement)
  sock.on('move', (move) => {
    try {
      const isWhiteTurn = chess.turn() === 'w'
      if (isWhiteTurn && sock.id !== players.white) return
      if (!isWhiteTurn && sock.id !== players.black) return

      const result = chess.move(move)
      if (result) {
        io.emit('move', move)
        io.emit('boardstate', chess.fen())
      } else {
        sock.emit('invalid move', move)
      }
    } catch (err) {
      console.error(err)
      sock.emit('invalid move', move)
    }
  })

  // --- WebRTC signaling (targeted to opponent only) ---
  sock.on('webrtc-offer', ({ offer }) => {
    const target = getOpponentId(sock.id)
    if (target) io.to(target).emit('webrtc-offer', { offer, from: sock.id })
  })

  sock.on('webrtc-answer', ({ answer }) => {
    const target = getOpponentId(sock.id)
    if (target) io.to(target).emit('webrtc-answer', { answer, from: sock.id })
  })

  sock.on('webrtc-ice-candidate', ({ candidate }) => {
    const target = getOpponentId(sock.id)
    if (target) io.to(target).emit('webrtc-ice-candidate', { candidate, from: sock.id })
  })

  // Disconnect cleanup
  sock.on('disconnect', () => {
    if (sock.id === players.white) players.white = null
    if (sock.id === players.black) players.black = null
    // Let everyone know the call should end
    io.emit('end-call')
    console.log('disconnected:', sock.id)
  })
})

server.listen(3000, () => {
  console.log('listening on http://localhost:3000')
})
