import { useState, useRef, useEffect } from 'react';
import { Mic, MicOff, Send, Trash2, Play, Pause } from 'lucide-react';
import toast from 'react-hot-toast';

const VoiceRecorder = ({ onRecordingComplete, autoSend = false }) => {
  const [isRecording, setIsRecording] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioUrl, setAudioUrl] = useState(null);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const audioRef = useRef(null);

  useEffect(() => {
    return () => {
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, [audioUrl]);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(stream);
      audioChunksRef.current = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorderRef.current.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const url = URL.createObjectURL(audioBlob);
        setAudioUrl(url);
        onRecordingComplete && onRecordingComplete(audioBlob, url);

        if (autoSend) {
          autoSendVoiceMessage(audioBlob);
        }
      };

      mediaRecorderRef.current.start();
      setIsRecording(true);
      setDuration(0);
    } catch (error) {
      console.error('Erro ao acessar microfone:', error);
      toast.error('Não foi possível acessar o microfone. Verifique as permissões.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const deleteRecording = () => {
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
      setDuration(0);
      setCurrentTime(0);
    }
  };

  const playRecording = () => {
    if (audioRef.current) {
      audioRef.current.play();
      setIsPlaying(true);
    }
  };

  const pauseRecording = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      setIsPlaying(false);
    }
  };

  const autoSendVoiceMessage = async (audioBlob) => {
    const formData = new FormData();
    formData.append('audio', audioBlob, 'recording.webm');

    try {
      const response = await fetch('/api/voice/upload', {
        method: 'POST',
        body: formData,
      });
      const data = await response.json();
    } catch (error) {
      console.error('Erro ao enviar áudio:', error);
    }
  };

  const sendVoiceMessage = () => {
    if (audioUrl && onRecordingComplete) {
      stopRecording();
      deleteRecording();
    }
  };

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleTimeUpdate = () => {
    if (audioRef.current) {
      setCurrentTime(audioRef.current.currentTime);
    }
  };

  const handleLoadedMetadata = () => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration);
    }
  };

  const handleEnded = () => {
    setIsPlaying(false);
    setCurrentTime(0);
  };

  useEffect(() => {
    let interval;
    if (isRecording) {
      interval = setInterval(() => {
        setDuration(prev => prev + 1);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isRecording]);

  return (
    <div className="voice-recorder">
      {!audioUrl ? (
        <button
          onClick={isRecording ? stopRecording : startRecording}
          className={`record-button ${isRecording ? 'recording' : ''}`}
          aria-label={isRecording ? 'Parar gravação' : 'Gravar mensagem de voz'}
        >
          {isRecording ? <MicOff size={24} /> : <Mic size={24} />}
        </button>
      ) : (
        <div className="voice-preview">
          <audio
            ref={audioRef}
            src={audioUrl}
            onTimeUpdate={handleTimeUpdate}
            onLoadedMetadata={handleLoadedMetadata}
            onEnded={handleEnded}
            className="visually-hidden"
          />

          <div className="voice-preview-info">
            <span className="voice-duration">{formatTime(duration)}</span>
          </div>

          <div className="voice-preview-controls">
            <button
              onClick={isPlaying ? pauseRecording : playRecording}
              className="voice-control-btn"
              aria-label={isPlaying ? 'Pausar' : 'Reproduzir'}
            >
              {isPlaying ? <Pause size={20} /> : <Play size={20} />}
            </button>

            <div className="voice-progress">
              <div
                className="voice-progress-bar"
                style={{ width: `${(currentTime / duration) * 100}%` }}
              />
            </div>

            {autoSend && (
              <button
                onClick={sendVoiceMessage}
                className="voice-send-btn"
                aria-label="Enviar mensagem de voz"
              >
                <Send size={20} />
              </button>
            )}

            <button
              onClick={deleteRecording}
              className="voice-delete-btn"
              aria-label="Excluir gravação"
            >
              <Trash2 size={20} />
            </button>
          </div>
        </div>
      )}

      {isRecording && (
        <div className="recording-indicator">
          <span className="recording-dot"></span>
          <span className="recording-text">Gravando {formatTime(duration)}</span>
        </div>
      )}
    </div>
  );
};

export default VoiceRecorder;
