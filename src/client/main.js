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

let peerConnection;
let dataChannel;
const room = () => window.sessionStorage.getItem("room");

function initConnect() {
  return new Promise((resolve) => {
    peerConnection = new RTCPeerConnection(servers);
    dataChannel = peerConnection.createDataChannel("sendChannel");

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
      // signalingSocket.send(JSON.stringify({ candidate }));
      signalingSocket.send(
        JSON.stringify({
          type: "candidate",
          room: room(),
          data: JSON.stringify({ candidate }),
        })
      );
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

    resolve();
  });
}

async function createOffer() {
  await initConnect();

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  // Offer를 signaling 서버를 통해 첫 번째 사용자에게 전달
  signalingSocket.send(
    JSON.stringify({
      type: "offer",
      room: room(),
      data: JSON.stringify({ offer }),
    })
  );

  console.log("offer 보냄");
}

// signalingServer 연결이 열리면
signalingSocket.onopen = () => {
  signalingSocket.send(JSON.stringify({ type: "userLength" }));
};

// signalingServer 응답
signalingSocket.onmessage = async (message) => {
  const msgData = JSON.parse(message.data);

  if (msgData.type === "userLength") {
    // 내 room을 sessionStorage에 저장
    if (!window.sessionStorage.getItem("room")) {
      window.sessionStorage.setItem("room", msgData.room);
    }

    if (msgData.length === 2) {
      await createOffer(); // 두번째 접속한 사람만 offer를 보내야함
    }
  }

  if (msgData.type === "offer") {
    console.log("offer 받음 ::: ", JSON.parse(msgData.data).offer);
    await initConnect();

    const offer = JSON.parse(msgData.data).offer;
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    // Answer를 signaling 서버를 통해 첫 번째 사용자에게 전달
    signalingSocket.send(
      JSON.stringify({
        type: "answer",
        room: room(),
        data: JSON.stringify({ answer }),
      })
    );

    console.log("answer 보냄");
  }

  if (msgData.type === "answer") {
    console.log("answer 받음 ::: ", JSON.parse(msgData.data).answer);
    const answer = JSON.parse(msgData.data).answer;
    await peerConnection.setRemoteDescription(
      new RTCSessionDescription(answer)
    );
  }

  if (msgData.type === "candidate") {
    console.log("candidate 받음 ::: ", JSON.parse(msgData.data).candidate);
    const candidate = JSON.parse(msgData.data).candidate;
    peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  }
};

// =====================================================================
