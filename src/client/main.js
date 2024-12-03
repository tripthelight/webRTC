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
  // console.log("DataChannel is open!");
  // dataChannel.send("Hello!");
};

dataChannel.onmessage = (event) => {
  // console.log("Received message: ", event.data);
};

peerConnection.onicecandidate = async (event) => {
  if (event.candidate) {
    console.log("New ICE candidate : ", event.candidate);
  }
};

async function createOffer() {
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
}

async function init() {
  await createOffer();
}

init();

socket.on("joined", (room) => {
  console.log("socket joined ::: ");
  socket.emit("ready", roomNumber);
});
