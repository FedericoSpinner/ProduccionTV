import React, { useState, useEffect, useRef } from 'react';
import { StyleSheet, View, Text, TextInput, TouchableOpacity, SafeAreaView, KeyboardAvoidingView, Platform, ScrollView, Image } from 'react-native';
import { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, mediaDevices, MediaStream } from 'react-native-webrtc';

type AppStep = 'JOIN' | 'ROLE' | 'CONNECTED';
type VoiceMode = 'OPEN' | 'PTT';

export default function VoiceChannelScreen() {
  const [step, setStep] = useState<AppStep>('JOIN');
  const [voiceMode, setVoiceMode] = useState<VoiceMode>('OPEN');
  
  const [channelId, setChannelId] = useState('');
  const [username, setUsername] = useState('');
  const [role, setRole] = useState({ name: '', emoji: '' });
  
  const [remoteName, setRemoteName] = useState('Esperando...');
  const [remoteRole, setRemoteRole] = useState({ name: '', emoji: '' });
  
  const [status, setStatus] = useState('Desconectado');
  const [activeChannels, setActiveChannels] = useState<string[]>([]);
  
  const [localSpeaking, setLocalSpeaking] = useState(false);
  const [remoteSpeaking, setRemoteSpeaking] = useState(false);
  
  const [isMutedByDirector, setIsMutedByDirector] = useState(false);
  const [remoteMuted, setRemoteMuted] = useState(false);
  
  // States newly added for toggling and pushing to talk
  const [globalMuteActive, setGlobalMuteActive] = useState(false);
  const [pttActive, setPttActive] = useState(false);
  
  const ws = useRef<WebSocket | null>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const statsInterval = useRef<NodeJS.Timeout | null>(null);

  const SIGNALING_URL = `wss://producciontv-server.onrender.com/ws/`;
  const HTTP_URL = `https://producciontv-server.onrender.com`;

  const roles = [
    { name: 'Director', emoji: '🎬' },
    { name: 'Cámaras', emoji: '🎥' },
    { name: 'Juego', emoji: '🎮' },
    { name: 'Entrevistas', emoji: '🎤' }
  ];

  const fetchChannels = async () => {
    try {
      const res = await fetch(`${HTTP_URL}/channels`);
      const data = await res.json();
      setActiveChannels(data.channels);
    } catch(e) { }
  };

  useEffect(() => {
    fetchChannels();
    const intv = setInterval(fetchChannels, 3000);
    return () => clearInterval(intv);
  }, []);

  const handleSelectChannel = (ch: string) => {
    if (!username.trim()) { setStatus('Ingresa tu nombre primero'); return; }
    setChannelId(ch);
    setStep('ROLE');
    setStatus('Selecciona tu Rol y Modo');
  };

  const handleStartCreation = () => {
    if (!username.trim() || !channelId.trim()) { setStatus('Ingresa usuario y nombre de sala'); return; }
    setStep('ROLE');
    setStatus('Selecciona tu Rol y Modo');
  };

  const setupWebRTC = async () => {
    try {
      const stream = await mediaDevices.getUserMedia({ audio: true, video: false });
      localStream.current = stream;
      
      // Aplicar estado inicial de micrófono ségun el modo seleccionado
      if (voiceMode === 'PTT') {
          stream.getAudioTracks()[0].enabled = false;
      }
      
      setStatus('Micrófono activado...');
    } catch (err) {
      setStatus('Error de micrófono. Revisa permisos.');
      throw err;
    }
  };

  const createPeerConnection = (selectedRole: any) => {
    const iceServers = [
      { urls: 'stun:global.relay.metered.ca:80' },
      { urls: 'turn:global.relay.metered.ca:80', username: '04efdbc91fad0ff00fae26fd', credential: '1ReZXsKtphudJhee' },
      { urls: 'turn:global.relay.metered.ca:80?transport=tcp', username: '04efdbc91fad0ff00fae26fd', credential: '1ReZXsKtphudJhee' },
      { urls: 'turn:global.relay.metered.ca:443', username: '04efdbc91fad0ff00fae26fd', credential: '1ReZXsKtphudJhee' },
      { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: '04efdbc91fad0ff00fae26fd', credential: '1ReZXsKtphudJhee' }
    ];
    const pc = new RTCPeerConnection({ iceServers });
    if (localStream.current) {
      localStream.current.getTracks().forEach(track => pc.addTrack(track, localStream.current!));
    }
    pc.onicecandidate = (e) => {
      if (e.candidate && ws.current) {
        ws.current.send(JSON.stringify({ type: 'candidate', candidate: e.candidate, name: username, role: selectedRole }));
      }
    };
    pc.ontrack = () => { console.log('Audio remoto recibido!'); };
    return pc;
  };

  const monitorSpeaking = () => {
    if (statsInterval.current) clearInterval(statsInterval.current);
    statsInterval.current = setInterval(async () => {
      if (!peerConnection.current) return;
      try {
        const stats = await peerConnection.current.getStats();
        let isRemote = false;
        let isLocal = false;
        stats.forEach(report => {
          if (report.type === 'inbound-rtp' && (report.kind === 'audio' || report.mediaType === 'audio')) {
            if (report.audioLevel && report.audioLevel > 0.02) isRemote = true;
          }
          if (report.type === 'media-source' && report.kind === 'audio') {
            if (report.audioLevel && report.audioLevel > 0.02) isLocal = true;
          }
        });
        setRemoteSpeaking(isRemote);
        setLocalSpeaking(isLocal);
      } catch (err) {}
    }, 200);
  };

  const connectToRoom = async (selectedRole: any) => {
    setRole(selectedRole);
    setStep('CONNECTED');
    setIsMutedByDirector(false);
    setRemoteMuted(false);
    setGlobalMuteActive(false);
    
    try { await setupWebRTC(); } catch (e) { return; }

    ws.current = new WebSocket(`${SIGNALING_URL}${channelId}/${selectedRole.name}`);

    ws.current.onopen = async () => {
      setStatus(`Conectado a #${channelId}`);
      peerConnection.current = createPeerConnection(selectedRole);
      monitorSpeaking();
      
      const offer = await peerConnection.current.createOffer({});
      await peerConnection.current.setLocalDescription(offer);
      ws.current?.send(JSON.stringify({ type: 'offer', offer, name: username, role: selectedRole }));
    };

    ws.current.onmessage = async (e) => {
      const message = JSON.parse(e.data);
      
      if (message.type === 'error') {
          setStatus(message.message);
          alert(message.message);
          leaveChannel();
          return;
      }
      
      if (message.type === 'director_mute') {
          if (localStream.current) {
             setIsMutedByDirector(message.muted);
             const audioTrack = localStream.current.getAudioTracks()[0];
             if (audioTrack) {
                 if (message.muted) {
                     audioTrack.enabled = false;
                 } else {
                     // Solo abrimos micrófono si su modo es Abierto
                     if (voiceMode === 'OPEN') audioTrack.enabled = true;
                 }
             }
          }
          return;
      }

      if (!peerConnection.current) return;

      if (message.name && message.name !== username) {
        setRemoteName(message.name);
        if (message.role) setRemoteRole(message.role);
      }

      if (message.type === 'offer') {
        await peerConnection.current.setRemoteDescription(new RTCSessionDescription(message.offer));
        const answer = await peerConnection.current.createAnswer();
        await peerConnection.current.setLocalDescription(answer);
        ws.current?.send(JSON.stringify({ type: 'answer', answer, name: username, role: selectedRole }));
      } else if (message.type === 'answer') {
        await peerConnection.current.setRemoteDescription(new RTCSessionDescription(message.answer));
      } else if (message.type === 'candidate' && message.candidate) {
        await peerConnection.current.addIceCandidate(new RTCIceCandidate(message.candidate));
      } else if (message.type === 'speaking') {
         if (message.name !== username) setRemoteSpeaking(message.isSpeaking);
      }
    };

    ws.current.onerror = () => setStatus('Error de conexión');
    ws.current.onclose = () => {
       if(step !== 'JOIN') setStatus('Desconectado por el servidor');
    };
  };

  const toggleRemoteMute = () => {
    if (peerConnection.current) {
      const receivers = peerConnection.current.getReceivers();
      const audioReceiver = receivers.find(r => r.track && r.track.kind === 'audio');
      if (audioReceiver && audioReceiver.track) {
         audioReceiver.track.enabled = !audioReceiver.track.enabled;
         setRemoteMuted(!audioReceiver.track.enabled);
      }
    }
  };

  const toggleDirectorGlobalMute = () => {
      const nextState = !globalMuteActive;
      setGlobalMuteActive(nextState);
      ws.current?.send(JSON.stringify({ type: 'director_mute', muted: nextState }));
  };

  const handlePttIn = () => {
      if (!isMutedByDirector && localStream.current) {
          localStream.current.getAudioTracks()[0].enabled = true;
          setPttActive(true);
      }
  };

  const handlePttOut = () => {
      if (localStream.current) {
          localStream.current.getAudioTracks()[0].enabled = false;
          setPttActive(false);
      }
  };

  const leaveChannel = () => {
    if (ws.current) ws.current.close();
    if (peerConnection.current) { peerConnection.current.close(); peerConnection.current = null; }
    if (localStream.current) { localStream.current.getTracks().forEach(t => t.stop()); localStream.current = null; }
    if (statsInterval.current) clearInterval(statsInterval.current);
    
    setStep('JOIN');
    setRemoteName('Esperando...');
    setRemoteRole({ name: '', emoji: '' });
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.inner}>
        <Image source={require('@/assets/images/logo.png')} style={styles.logo} resizeMode="contain" />
        <Text style={styles.status}>{status}</Text>

        {step === 'JOIN' && (
          <View style={styles.joinContainer}>
            <TextInput style={styles.input} placeholder="Tu nombre" placeholderTextColor="#999" value={username} onChangeText={setUsername} />
            
            <Text style={styles.subtitle}>SALAS ACTIVAS</Text>
            <ScrollView style={styles.channelsList}>
              {activeChannels.length === 0 ? (
                <Text style={styles.noChannels}>no hay salas activas en este momento</Text>
              ) : (
                activeChannels.map(ch => (
                  <TouchableOpacity key={ch} style={styles.channelButton} onPress={() => handleSelectChannel(ch)}>
                    <Text style={styles.channelButtonText}>🔈 Unirse a #{ch}</Text>
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>

            <Text style={styles.subtitle}>O CREA UNA NUEVA:</Text>
            <TextInput style={styles.input} placeholder="Nombre de sala nueva" placeholderTextColor="#999" value={channelId} onChangeText={setChannelId} autoCapitalize="none" />
            <TouchableOpacity style={styles.button} onPress={handleStartCreation}>
              <Text style={styles.buttonText}>Crear y Unirse</Text>
            </TouchableOpacity>
          </View>
        )}

        {step === 'ROLE' && (
          <View style={styles.joinContainer}>
             <Text style={styles.subtitle}>MODO DE VOZ</Text>
             <View style={styles.modeContainer}>
               <TouchableOpacity style={[styles.modeButton, voiceMode === 'OPEN' && styles.modeActive]} onPress={() => setVoiceMode('OPEN')}>
                  <Text style={styles.modeText}>🎙️ Abierto</Text>
               </TouchableOpacity>
               <TouchableOpacity style={[styles.modeButton, voiceMode === 'PTT' && styles.modeActive]} onPress={() => setVoiceMode('PTT')}>
                  <Text style={styles.modeText}>👆 PTT</Text>
               </TouchableOpacity>
             </View>

             <Text style={styles.subtitle}>ELIGE TU ROL PARA ENTRAR A #{channelId}</Text>
             {roles.map(r => (
                <TouchableOpacity key={r.name} style={styles.roleButton} onPress={() => connectToRoom(r)}>
                   <Text style={styles.roleEmoji}>{r.emoji}</Text>
                   <Text style={styles.roleText}>{r.name}</Text>
                </TouchableOpacity>
             ))}
             <TouchableOpacity style={[styles.button, {backgroundColor: '#555', marginTop: 10}]} onPress={() => setStep('JOIN')}>
                <Text style={styles.buttonText}>Volver</Text>
             </TouchableOpacity>
          </View>
        )}

        {step === 'CONNECTED' && (
          <View style={styles.channelContainer}>
            <View style={styles.usersGrid}>
              
              <View style={styles.userCard}>
                <View style={[styles.avatarPlaceholder, (localSpeaking || pttActive) && styles.avatarSpeaking, isMutedByDirector && {borderColor: '#ed4245'}]}>
                  <Text style={styles.avatarText}>{username.charAt(0).toUpperCase()}</Text>
                </View>
                <Text style={styles.roleBadge}>{role.emoji} {role.name}</Text>
                <Text style={[styles.userName, isMutedByDirector && {color: '#ed4245'}]}>{username} {isMutedByDirector ? '(Mut. Director)' : '(Tú)'}</Text>
              </View>

              <View style={styles.userCard}>
                <View style={[styles.avatarPlaceholder, remoteSpeaking && styles.avatarSpeaking, remoteMuted && {opacity: 0.5}]}>
                  <Text style={styles.avatarText}>{remoteName !== 'Esperando...' ? remoteName.charAt(0).toUpperCase() : '?'}</Text>
                </View>
                {remoteRole.name ? <Text style={styles.roleBadge}>{remoteRole.emoji} {remoteRole.name}</Text> : null}
                <Text style={styles.userName}>{remoteName}</Text>
                
                {remoteName !== 'Esperando...' && (
                  <TouchableOpacity onPress={toggleRemoteMute} style={styles.muteRemoteBtn}>
                     <Text style={{color: remoteMuted ? '#ed4245' : '#b9bbbe', fontWeight: 'bold'}}>
                       {remoteMuted ? '🔇 Desmutear' : '🔊 Mutear'}
                     </Text>
                  </TouchableOpacity>
                )}
              </View>
              
            </View>

            {voiceMode === 'PTT' && (
              <TouchableOpacity 
                  activeOpacity={0.8}
                  onPressIn={handlePttIn} 
                  onPressOut={handlePttOut} 
                  style={[styles.pttButton, pttActive && styles.pttActive, isMutedByDirector && {backgroundColor: '#555'}]}
                  disabled={isMutedByDirector}
              >
                  <Text style={styles.pttButtonText}>{isMutedByDirector ? 'MUTEADO POR EL DIRECTOR' : '👆 MANTÉN PULSADO PARA HABLAR'}</Text>
              </TouchableOpacity>
            )}

            {role.name === 'Director' && (
              <TouchableOpacity style={[styles.button, {backgroundColor: globalMuteActive ? '#43b581' : '#ca383a', marginTop: 15}]} onPress={toggleDirectorGlobalMute}>
                <Text style={styles.buttonText}>{globalMuteActive ? '🔊 Desmutear a todos' : '🔇 Silenciar a todos'}</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity style={[styles.button, styles.leaveButton]} onPress={leaveChannel}>
              <Text style={styles.buttonText}>Desconectar</Text>
            </TouchableOpacity>
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#36393f' },
  inner: { flex: 1, padding: 24, justifyContent: 'center', alignItems: 'center' },
  logo: { width: '80%', height: 80, marginBottom: 15 },
  title: { fontSize: 32, fontWeight: 'bold', color: '#fff', marginBottom: 5 },
  status: { fontSize: 16, color: '#b9bbbe', marginBottom: 20, textAlign: 'center' },
  joinContainer: { width: '100%', alignItems: 'center', flex: 1, justifyContent: 'center' },
  subtitle: { color: '#b9bbbe', fontSize: 14, marginBottom: 8, alignSelf: 'flex-start', fontWeight: 'bold' },
  
  modeContainer: { flexDirection: 'row', width: '100%', justifyContent: 'space-between', marginBottom: 20 },
  modeButton: { flex: 1, backgroundColor: '#2f3136', padding: 12, borderRadius: 8, alignItems: 'center', marginHorizontal: 5, borderWidth: 2, borderColor: '#2f3136' },
  modeActive: { borderColor: '#5865F2' },
  modeText: { color: '#fff', fontWeight: '600' },

  channelsList: { width: '100%', maxHeight: 150, marginBottom: 15 },
  noChannels: { color: '#72767d', fontStyle: 'italic', marginBottom: 10, fontSize: 15 },
  channelButton: { backgroundColor: '#4f545c', padding: 14, borderRadius: 6, marginBottom: 8, width: '100%' },
  channelButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  input: { width: '100%', height: 55, backgroundColor: '#202225', borderRadius: 8, paddingHorizontal: 16, color: '#fff', fontSize: 18, marginBottom: 15 },
  button: { backgroundColor: '#5865F2', paddingVertical: 16, paddingHorizontal: 32, borderRadius: 8, width: '100%', alignItems: 'center', marginTop: 10 },
  leaveButton: { backgroundColor: '#ed4245', marginTop: 15 },
  buttonText: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  
  pttButton: { backgroundColor: '#4f545c', paddingVertical: 25, borderRadius: 12, width: '100%', alignItems: 'center', marginTop: 30, borderWidth: 3, borderColor: '#2f3136' },
  pttActive: { backgroundColor: '#5865F2', borderColor: '#4752C4' },
  pttButtonText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },

  roleButton: { backgroundColor: '#2f3136', padding: 15, borderRadius: 8, width: '100%', alignItems: 'center', marginBottom: 10, flexDirection: 'row', justifyContent: 'center', borderWidth: 1, borderColor: '#4f545c' },
  roleEmoji: { fontSize: 24, marginRight: 10 },
  roleText: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  roleBadge: { backgroundColor: '#202225', color: '#fff', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, fontSize: 13, marginBottom: 5, overflow: 'hidden' },
  
  channelContainer: { alignItems: 'center', width: '100%' },
  usersGrid: { flexDirection: 'row', justifyContent: 'space-around', width: '100%', marginTop: 20 },
  userCard: { alignItems: 'center', width: '45%' },
  avatarPlaceholder: { width: 90, height: 90, borderRadius: 45, backgroundColor: '#2f3136', justifyContent: 'center', alignItems: 'center', marginBottom: 10, borderWidth: 3, borderColor: 'transparent' },
  avatarSpeaking: { borderColor: '#43b581', shadowColor: '#43b581', shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.8, shadowRadius: 10, elevation: 10 },
  avatarText: { color: '#fff', fontWeight: 'bold', fontSize: 32 },
  userName: { color: '#fff', fontSize: 14, fontWeight: '600', textAlign: 'center' },
  muteRemoteBtn: { marginTop: 10, backgroundColor: '#202225', paddingVertical: 6, paddingHorizontal: 12, borderRadius: 6 }
});
