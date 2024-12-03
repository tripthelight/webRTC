const socket = io();
const servers = {
  iceServers: [
    {
      urls: [
        "stun:stun.l.google.com:19302",
        "stun:stun1.l.google.com:19302",
        "stun:stun2.l.google.com:19302",
      ],
    },
  ],
};
const peerConnection = new RTCPeerConnection(servers);

// DataChannel 생성
// DataChannel이 없으면 candidate를 안찾음
const dataChannel = peerConnection.createDataChannel("chat");

dataChannel.onopen = () => {
  console.log("DataChannel is open!");
  // dataChannel.send("Hello!");
};

dataChannel.onmessage = (event) => {
  console.log("Received message: ", event.data);
};

peerConnection.onicecandidate = async (event) => {
  if (event.candidate) {
    console.log("New ICE candidate : ", event.candidate);
  }
};

async function createOffer() {
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  socket.send({ offer: offer });
}

async function init() {
  socket.emit("create or join", "aaa");
  // await createOffer();
}

init();

async function handleUserCreated(data) {
  const { type, userId } = data;
  console.log("A new user created the channel: ", userId);
  await createOffer();
}

async function handleUserJoined(data) {
  const { type, userId } = data;
  console.log("A new user joined the channel: ", userId);
}

socket.on("create", handleUserCreated);
socket.on("join", handleUserJoined);

// socket.on("MemberJoined", (room) => {
//   console.log("socket joined ::: ");
//   socket.emit("ready", roomNumber);
// });
