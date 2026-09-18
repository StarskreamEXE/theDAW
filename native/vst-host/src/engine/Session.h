// One live plugin session: the plugin instance, the WebSocket server, the
// realtime audio thread and the control plane that connects them.
//
// Thread map (docs/design/vst-live-protocol.md, "Threads and real-time rules"):
//   MESSAGE thread  - everything that touches the plugin object except process()
//   AUDIO thread    - owns the client socket, calls process(), never allocates
//   acceptor thread - HTTP upgrade, then hands the socket over
//   stdin / parent watchdog / logger - detached helpers that only post a quit
#pragma once

#include <windows.h>

#include <atomic>
#include <memory>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include "../net/WsFrame.h"
#include "../net/WsServer.h"
#include "../plugin/IPluginInstance.h"
#include "../util/Args.h"
#include "../util/Json.h"
#include "../util/SpscQueue.h"
#include "AudioFrame.h"
#include "DelayLine.h"
#include "MessageLoop.h"

namespace thedaw {

// Reported by the audio thread, turned into JSON by the message thread.
enum class AudioNoticeCode : uint32_t {
    None = 0,
    NotReady,
    ShortFrame,
    BadMagic,
    BadType,
    BadChannels,
    BadFrameCount,
    FrameTooLarge,
    ProtocolViolation,
    ClientGone,
};

struct AudioNotice {
    AudioNoticeCode code = AudioNoticeCode::None;
    uint32_t a = 0;
    uint32_t b = 0;
};

class Session final : public IPluginEvents {
public:
    Session();
    ~Session() override;
    Session(const Session&) = delete;
    Session& operator=(const Session&) = delete;

    // MESSAGE thread. Loads and prepares the plugin, restores --state-file,
    // starts the server and the audio thread. On failure `exitCode` carries the
    // contract's exit code.
    bool start(const Options& options, MessageLoop& loop, std::string& error,
               int& exitCode);

    // MESSAGE thread. park -> closeEditor -> getState -> state file -> release.
    void stop();

    int port() const { return server_.port(); }

    // ---- IPluginEvents (MESSAGE thread) ----
    void onLatencyChanged(int32_t latencySamples) override;
    void onParamEdited(int32_t index, double normalizedValue) override;
    void onEditorResized(int32_t width, int32_t height) override;
    void onEditorClosed() override;
    void onWarning(const std::string& text) override;
    void onRestartRequired() override;

private:
    struct ParamEcho {
        double value = 0.0;
        bool pending = false;
        ULONGLONG lastSentMs = 0;
    };

    // ---- message thread ----
    static void controlEventTrampoline(void* context);
    static void tickTrampoline(void* context);
    // Runs on the acceptor thread; hops to the message thread.
    static void acceptorConnectedTrampoline(void* context);
    static void clientConnectedTrampoline(void* context);

    void drainControlQueue();
    void drainAudioNotices();
    void tick();
    void onClientConnected();
    void onClientGone();

    void handleControlText(const std::string& text);
    void handleOp(const json::Value& message, const std::string& op);

    void sendText(std::string text);
    void sendReady();
    void sendParams();
    void sendStateMessage();
    void sendError(const std::string& text, bool fatal);
    // A plugin fault: reports error{fatal:true} and exits with code 4.
    void reportPluginFault(const std::string& text);
    void sendWarningMessage(const std::string& text);
    void sendEditorState(bool open, int width, int height);
    void flushParamEchoes(bool force);

    bool captureState(std::vector<uint8_t>& out, std::string& error);
    bool writeStateFile();
    void restoreStateFile();
    void applyLatency(int32_t latencySamples);

    bool parkAudio();
    void resumeAudio();

    // ---- audio thread ----
    void audioLoop();
    // A queued set_param only reaches a VST3 plugin inside a process call. When the client has
    // stopped sending audio (a knob move with the transport stopped), nothing would deliver it,
    // so after ~20 ms without an audio_in block the audio thread makes the zero-sample call
    // itself. Runs between blocks on this thread, so it can never overlap a real process().
    void maybeFlushParameters();
    void dropClient();
    bool handleSocketMessage(const net::FrameReader::Message& message);
    void handleAudioBlock(const uint8_t* data, size_t size);
    bool sendFrame(net::Opcode opcode, const uint8_t* payload, size_t size);
    void drainOutgoing();
    void pushNotice(AudioNoticeCode code, uint32_t a = 0, uint32_t b = 0);

    // ---- configuration / plugin ----
    Options options_;
    MessageLoop* loop_ = nullptr;
    std::unique_ptr<IPluginInstance> plugin_;
    PluginInfo pluginInfo_;
    PrepareResult prepared_;
    bool hasEditor_ = false;
    bool stateCompatible_ = false;
    std::vector<std::string> startupWarnings_;

    // ---- networking ----
    net::WinsockScope winsock_;
    net::WsServer server_;
    net::FrameReader reader_;
    std::atomic<SOCKET> clientSocket_{INVALID_SOCKET};

    // ---- threads / handshakes ----
    std::thread audioThread_;
    std::atomic<bool> stopping_{false};
    std::atomic<bool> parkRequest_{false};
    HANDLE parkedEvent_ = nullptr;
    HANDLE resumeEvent_ = nullptr;
    HANDLE stopEvent_ = nullptr;
    HANDLE controlEvent_ = nullptr;
    bool parked_ = false;

    // ---- queues ----
    util::SpscQueue<std::string, 64> incoming_;   // audio -> message
    util::SpscQueue<std::string, 64> outgoing_;   // message -> audio
    util::SpscQueue<AudioNotice, 64> notices_;    // audio -> message

    // ---- control-plane state (message thread) ----
    bool helloSeen_ = false;
    std::atomic<bool> ready_{false};
    std::unordered_map<int32_t, ParamEcho> paramEchoes_;
    ULONGLONG lastActivityMs_ = 0;
    ULONGLONG lastXrunReportMs_ = 0;
    bool editorOpen_ = false;
    bool stopped_ = false;  // message thread only; makes stop() idempotent

    // Set by the message thread when it hands a set_param to the plugin, cleared by the audio
    // thread when it flushes. Losing a set edit is not possible: the flag is cleared before the
    // flush, so an edit queued during the flush re-arms it.
    std::atomic<bool> paramFlushPending_{false};

    // ---- audio thread state ----
    // GetTickCount64() of the last audio_in block this thread processed; 0 = none yet.
    ULONGLONG lastAudioBlockMs_ = 0;
    std::vector<float> wireIn_;
    std::vector<float> pluginIn_;
    std::vector<float> pluginOut_;
    std::vector<float> dryDelayed_;
    std::vector<float> dryMapped_;
    std::vector<float> wireOut_;
    std::vector<uint8_t> txBuffer_;
    float* wireInPtr_[kMaxWireChannels] = {};
    float* pluginInPtr_[kMaxWireChannels] = {};
    float* pluginOutPtr_[kMaxWireChannels] = {};
    float* dryDelayedPtr_[kMaxWireChannels] = {};
    float* dryMappedPtr_[kMaxWireChannels] = {};
    float* wireOutPtr_[kMaxWireChannels] = {};
    DelayLine bypassDelay_;
    float bypassGain_ = 0.0f;  // 0 = fully wet, 1 = fully dry
    float bypassStep_ = 1.0f;
    std::atomic<bool> bypassTarget_{false};

    // ---- measurement ----
    double qpcToMicros_ = 0.0;
    std::atomic<uint32_t> lateBlocks_{0};
    std::atomic<uint32_t> maxProcessMicros_{0};
};

}  // namespace thedaw
