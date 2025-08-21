// ---------- Socket & Chess ----------
const socket = io()
const chess = new Chess()
const boardelement = document.querySelector('.chessboard')
const roleLabel = document.getElementById('roleLabel')
const turnLabel = document.getElementById('turnLabel')
const callStatus = document.getElementById('callStatus')

let dragpiece = null
let sourcesqr = null
let playerrole = null

const renderboard = () => {
  const board = chess.board()
  boardelement.innerHTML = ""
  board.forEach((row, rowindex) => {
    row.forEach((sqr, sqrindex) => {
      const sqrelement = document.createElement("div")
      sqrelement.classList.add("square", (rowindex + sqrindex) % 2 === 0 ? "light" : "dark")
      sqrelement.dataset.row = rowindex
      sqrelement.dataset.col = sqrindex

      if (sqr) {
        const pieceelement = document.createElement("div")
        pieceelement.classList.add("piece", sqr.color === 'w' ? "white" : "black")
        pieceelement.innerText = getpieceunicode(sqr)

        // Only allow dragging your own pieces
        pieceelement.draggable = (playerrole === sqr.color)

        pieceelement.addEventListener('dragstart', (e) => {
          if (pieceelement.draggable) {
            dragpiece = pieceelement
            sourcesqr = { row: rowindex, col: sqrindex }
            e.dataTransfer.setData("text/plain", "")
          }
        })
        pieceelement.addEventListener("dragend", () => {
          dragpiece = null
          sourcesqr = null
        })
        sqrelement.appendChild(pieceelement)
      }

      sqrelement.addEventListener("dragover", (e) => e.preventDefault())
      sqrelement.addEventListener("drop", (e) => {
        e.preventDefault()
        if (dragpiece) {
          const targetsource = {
            row: parseInt(sqrelement.dataset.row, 10),
            col: parseInt(sqrelement.dataset.col, 10),
          }
          handlemove(sourcesqr, targetsource)
        }
      })
      boardelement.appendChild(sqrelement)
    })
  })

  turnLabel.textContent = chess.turn() === 'w' ? 'White' : 'Black'
}

const handlemove = (source, target) => {
  const move = {
    from: String.fromCharCode(97 + source.col) + (8 - source.row),
    to: String.fromCharCode(97 + target.col) + (8 - target.row),
    promotion: "q" // simple MVP: always promote to queen
  }

  const result = chess.move(move)
  if (result) {
    renderboard()
    socket.emit("move", move)
  } else {
    console.log("Invalid move:", move)
  }
}

const getpieceunicode = (piece) => {
  const unicodePieces = {
    w: { p: "♙", r: "♖", n: "♘", b: "♗", q: "♕", k: "♔" },
    b: { p: "♟", r: "♜", n: "♞", b: "♝", q: "♛", k: "♚" }
  }
  return unicodePieces[piece.color][piece.type]
}

// Role assignment
socket.on("playerrole", (role) => {
  playerrole = role
  roleLabel.textContent = role === 'w' ? 'White' : 'Black'
  maybeInitMedia() // start cam/mic early; actual call starts when server emits 'start-call'
})

socket.on("spectator", () => {
  playerrole = null
  roleLabel.textContent = 'Spectator'
})

socket.on("boardstate", (fen) => {
  chess.load(fen)
  renderboard()
})

socket.on("move", (move) => {
  chess.move(move)
  renderboard()
})

renderboard()

// ---------- WebRTC (two players only) ----------
let localStream = null
let peerConnection = null
let isMicOn = true
let isCamOn = true

const localVideo = document.getElementById('localVideo')
const remoteVideo = document.getElementById('remoteVideo')
const btnToggleCam = document.getElementById('btnToggleCam')
const btnToggleMic = document.getElementById('btnToggleMic')
const btnLeaveCall = document.getElementById('btnLeaveCall')

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' }
  ]
}

async function maybeInitMedia() {
  try {
    if (!localStream) {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      localVideo.srcObject = localStream
    }
  } catch (e) {
    console.error('Failed to get media:', e)
    callStatus.textContent = 'Camera/Mic permission denied or unavailable.'
  }
}

function createPeer() {
  const pc = new RTCPeerConnection(rtcConfig)

  // Add local tracks
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream))
  }

  // Incoming remote tracks
  pc.ontrack = (event) => {
    const [stream] = event.streams
    remoteVideo.srcObject = stream
  }

  // ICE to opponent
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-ice-candidate', { candidate: event.candidate })
    }
  }

  pc.onconnectionstatechange = () => {
    callStatus.textContent = `Call: ${pc.connectionState}`
  }

  return pc
}

// Server says both players are ready → start negotiation
socket.on('start-call', async () => {
  if (!playerrole) {
    callStatus.textContent = 'Spectators do not join video.'
    return
  }
  await maybeInitMedia()
  peerConnection = createPeer()

  // Only the player who is White starts the offer (simple rule to avoid glare)
  if (playerrole === 'w') {
    const offer = await peerConnection.createOffer()
    await peerConnection.setLocalDescription(offer)
    socket.emit('webrtc-offer', { offer })
  } else {
    callStatus.textContent = 'Waiting for offer from opponent…'
  }
})

// Signaling handlers
socket.on('webrtc-offer', async ({ offer }) => {
  await maybeInitMedia()
  if (!peerConnection) peerConnection = createPeer()

  await peerConnection.setRemoteDescription(new RTCSessionDescription(offer))
  const answer = await peerConnection.createAnswer()
  await peerConnection.setLocalDescription(answer)
  socket.emit('webrtc-answer', { answer })
})

socket.on('webrtc-answer', async ({ answer }) => {
  if (!peerConnection) return
  await peerConnection.setRemoteDescription(new RTCSessionDescription(answer))
})

socket.on('webrtc-ice-candidate', async ({ candidate }) => {
  try {
    if (peerConnection) {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
    }
  } catch (err) {
    console.error('Error adding ICE candidate', err)
  }
})

socket.on('end-call', () => {
  teardownCall()
  callStatus.textContent = 'Opponent disconnected. Call ended.'
})

function teardownCall() {
  if (peerConnection) {
    peerConnection.ontrack = null
    peerConnection.onicecandidate = null
    peerConnection.close()
    peerConnection = null
  }
  if (remoteVideo) remoteVideo.srcObject = null
}

// --- UI Controls ---
btnToggleCam.addEventListener('click', () => {
  if (!localStream) return
  isCamOn = !isCamOn
  localStream.getVideoTracks().forEach(t => t.enabled = isCamOn)
  btnToggleCam.textContent = isCamOn ? 'Toggle Cam' : 'Turn Cam On'
})

btnToggleMic.addEventListener('click', () => {
  if (!localStream) return
  isMicOn = !isMicOn
  localStream.getAudioTracks().forEach(t => t.enabled = isMicOn)
  btnToggleMic.textContent = isMicOn ? 'Toggle Mic' : 'Turn Mic On'
})

btnLeaveCall.addEventListener('click', () => {
  teardownCall()
  callStatus.textContent = 'You left the call.'
})
