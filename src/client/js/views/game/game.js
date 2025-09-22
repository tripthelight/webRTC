import {createSignaling} from '../../../ws/signaling.js';
import {createManualPeer} from '../../../rtc/manualPeer.js';
import {createPeerPN} from '../../../rtc/peerPN.js';

const room = new URL(location.href).searchParams.get('room') || 'test';
const signaling = createSignaling(room);
