1. youtube

   - https://www.youtube.com/watch?v=QsH8FL0952k&t=201s&ab_channel=TraversyMedia

2. gpt

   - https://chatgpt.com/c/674e6ddd-ed34-800f-9d73-2a3a67daa0e3

3. 진행단계
   - 새로고침 후 재연결 테스트 중
   - peerConnection, dataChannel, peerConnection.onicecandidate, dataChannel.onmessage 을 먼저 설정하고, offer, answer를 주고 받아야 새로고침 해도 재연결이 됨
   - TODO: server.js에서 연결되어 있는 user 연결이 좀 이상해..
   - 여러 브라우저에서 테스트 필요
  
4. chatGPT 검색
- 5-2. 클라이언트: PN 전용 Peer 뼈대 추가
- 새 파일: client/src/rtc/peerPN.js
- 일단 상태 변수/핵심 핸들러 이름만 만들어 둡니다. (아직 onnegotiationneeded 로직은 비워둠)
