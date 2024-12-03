// WebSocket 연결 설정
const signalingSocket = new WebSocket("ws://localhost:4000");
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

// 연결이 열리면
signalingSocket.onopen = () => {
  signalingSocket.send("userLength");
};

// DataChannel 생성
// DataChannel이 없으면 candidate를 안찾음
const dataChannel = peerConnection.createDataChannel("sendChannel");

// 메시지 전송 함수
const sendTapEvent = () => {
  if (dataChannel && dataChannel.readyState === "open") {
    dataChannel.send("tap !");
  } else {
    console.log("dataChannel not ready...");
  }
};

dataChannel.onopen = () => {
  console.log("dataChannel is open!");
  // dataChannel.send("Hello!");
  const RTC_BTN = document.querySelector(".rtc-btn");
  // RTC_BTN.addEventListener("click", sendTapEvent);
  RTC_BTN.onclick = () => {
    sendTapEvent();
  };
};

dataChannel.onmessage = (event) => {
  console.log("dataChannel.onmessage :: ");

  // console.log("Received message: ", event.data);
};

dataChannel.onclose = () => {
  console.log("dataChannel is closed!");
};

dataChannel.onerror = (error) => {
  console.log("DataChannel error: ", error);
};

// ICE 후보를 다른 브라우저로 전송 (같은 방 안에서만 전송)
function sendCandidate(candidate) {
  signalingSocket.send(JSON.stringify({ candidate }));
}

peerConnection.onicecandidate = async (event) => {
  if (event.candidate) {
    // console.log("New ICE candidate : ", event.candidate);
    sendCandidate(event.candidate);
  }
};

peerConnection.oniceconnectionstatechange = (event) => {
  console.log("ICE Connection State: ", peerConnection.iceConnectionState);
  if (peerConnection.iceConnectionState === "connected") {
    console.log("Bridges are successfully connected!");
  }
};

peerConnection.onconnectionstatechange = (event) => {
  console.log("Peer connection state: ", peerConnection.connectionState);
  if (dataChannel.readyState === "open") {
    console.log("Data channel is open, communication can begin!");
  }
};

async function createOffer() {
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  console.log("offer : ", offer);

  // Offer를 signaling 서버를 통해 두 번째 사용자에게 전달
  signalingSocket.send(JSON.stringify({ offer }));
}

async function init() {
  await createOffer(); // 첫번째 접속한 사람만 offer를 보내야함
}

init();

signalingSocket.onmessage = async (message) => {
  const msgData = JSON.parse(message.data);

  // if (msgData.type === "userLength") {
  //   if (msgData.length === 1) {
  //     console.log("msgData.length ::: ", msgData.length);
  //     await createOffer(); // 첫번째 접속한 사람만 offer를 보내야함
  //   }
  // }

  if (msgData.offer) {
    console.log("msgData.offer : ", msgData.offer);
    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(msgData.offer)
    );
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    // Answer를 signaling 서버를 통해 첫 번째 사용자에게 전달
    signalingSocket.send(JSON.stringify({ answer }));
  }

  if (msgData.answer) {
    console.log("msgData.answer : ", msgData.answer);
    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(msgData.answer)
    );
  }

  if (msgData.candidate) {
    console.log("msgData.candidate : ", msgData.candidate);
    peerConnection.addIceCandidate(new RTCIceCandidate(msgData.candidate));
  }
};

// =====================================================================
