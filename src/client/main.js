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

// DataChannel 생성
// DataChannel이 없으면 candidate를 안찾음
const dataChannel = peerConnection.createDataChannel("sendChannel");

// 메시지 전송 함수
/*
const sendTapEvent = () => {
  if (dataChannel && dataChannel.readyState === "open") {
    const obj = {
      message: "hello !!!!!!!!!!!!!!!!",
      timestamp: new Date(),
    };
    dataChannel.send(JSON.stringify(obj));
  } else {
    console.log("dataChannel not ready...");
  }
};
*/

peerConnection.ondatachannel = (event) => {
  const onDataChannel = event.channel;
  const RTC_BTN = document.querySelector(".rtc-btn");
  if (onDataChannel && onDataChannel.readyState === "open") {
    RTC_BTN.onclick = () => {
      onDataChannel.send("hello !!!!!!!!");
    };
  }
};

dataChannel.onopen = () => {
  // console.log("dataChannel is open!");
};

dataChannel.onmessage = (event) => {
  console.log("Received message: ", event.data);
};

dataChannel.onclose = () => {
  // console.log("dataChannel is closed!");
};

dataChannel.onerror = (error) => {
  // console.log("DataChannel error: ", error);
};

// ICE 후보를 다른 브라우저로 전송 (같은 방 안에서만 전송)
function sendCandidate(candidate) {
  console.log("candidate 보냄");
  signalingSocket.send(JSON.stringify({ candidate }));

  sessionStorage.setItem("candidate", JSON.stringify(candidate));
}

peerConnection.onicecandidate = async (event) => {
  if (event.candidate) {
    sendCandidate(event.candidate);
  }
};

peerConnection.oniceconnectionstatechange = (event) => {
  // console.log("ICE Connection State: ", peerConnection.iceConnectionState);
  if (peerConnection.iceConnectionState === "connected") {
    // console.log("Bridges are successfully connected!");
  }
};

peerConnection.onconnectionstatechange = (event) => {
  // console.log("Peer connection state: ", peerConnection.connectionState);
  if (dataChannel.readyState === "open") {
    // console.log("Data channel is open, communication can begin!");
  }
};

async function createOffer() {
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  // Offer를 signaling 서버를 통해 첫 번째 사용자에게 전달
  signalingSocket.send(JSON.stringify({ offer }));
  sessionStorage.setItem("offer", JSON.stringify(offer));
  console.log("offer 보냄");
}

/*
async function init() {
  // await createOffer(); // 첫번째 접속한 사람만 offer를 보내야함
}

document.onreadystatechange = () => {
  const state = document.readyState;
  if (state === "interactive") {
  } else if (state === "complete") {
    init();
  }
};
*/

// 연결이 열리면
signalingSocket.onopen = () => {
  signalingSocket.send("userLength");
};

signalingSocket.onmessage = async (message) => {
  const msgData = JSON.parse(message.data);

  if (msgData.type === "userLength") {
    if (msgData.length === 1) {
      // console.log("msgData.length ::: ", msgData.length);
      // if (!window.sessionStorage.getItem("entryOrder")) {
      //   window.sessionStorage.setItem("entryOrder", "entryOrder1");
      // }
    }
    if (msgData.length === 2) {
      // console.log("msgData.length ::: ", msgData.length);
      // if (!window.sessionStorage.getItem("entryOrder")) {
      //   window.sessionStorage.setItem("entryOrder", "entryOrder2");
      // }
      await createOffer(); // 두번째 접속한 사람만 offer를 보내야함
    }
  }

  if (msgData.offer) {
    console.log("offer 받음");
    // console.log("msgData.offer : ", msgData.offer);
    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(msgData.offer)
    );
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    // Answer를 signaling 서버를 통해 첫 번째 사용자에게 전달
    signalingSocket.send(JSON.stringify({ answer }));

    sessionStorage.setItem("offer", JSON.stringify(msgData.offer));
    sessionStorage.setItem("answer", JSON.stringify(answer));

    console.log("answer 보냄");
  }

  if (msgData.answer) {
    console.log("answer 받음");
    // console.log("msgData.answer : ", msgData.answer);
    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(msgData.answer)
    );

    sessionStorage.setItem("answer", JSON.stringify(msgData.answer));
  }

  if (msgData.candidate) {
    console.log("candidate 받음");
    // console.log("msgData.candidate : ", msgData.candidate);
    peerConnection.addIceCandidate(new RTCIceCandidate(msgData.candidate));

    sessionStorage.setItem("candidate", JSON.stringify(msgData.candidate));
  }
};

// 새로고침 후 복원 (다시 offer, answer, candidate 사용)
function restoreSessionData() {
  const offer = JSON.parse(sessionStorage.getItem("offer"));
  const answer = JSON.parse(sessionStorage.getItem("answer"));
  const candidates = JSON.parse(sessionStorage.getItem("candidates"));

  if (offer && answer && candidates) {
    // 저장된 데이터를 통해 연결 복원
    peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    peerConnection.setLocalDescription(new RTCSessionDescription(answer));
    candidates.forEach((candidate) => {
      peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    });
  }
}

// =====================================================================
