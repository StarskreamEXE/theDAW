// Event lists for the process call.
//
// theDAW's live host is an audio-effect host: it sends no notes and consumes none. But an event
// bus that is active and handed a null list makes some plugins reach for it anyway, so every
// block gets a real, empty list instead of a null pointer. The output list accepts events and
// drops them, which is the correct behaviour for a host with nowhere to put them.
#pragma once

#include "pluginterfaces/vst/ivstevents.h"

#include "vst3_common.h"

namespace thedaw::vst3 {

class EmptyEventList final : public Steinberg::Vst::IEventList, public HostObject {
public:
    Steinberg::tresult PLUGIN_API queryInterface(const Steinberg::TUID wantedIid, void** obj) SMTG_OVERRIDE {
        if (obj == nullptr) return Steinberg::kInvalidArgument;
        *obj = nullptr;
        THEDAW_VST3_OFFER(Steinberg::Vst::IEventList)
        THEDAW_VST3_OFFER(Steinberg::FUnknown)
        return Steinberg::kNoInterface;
    }
    THEDAW_VST3_REFCOUNT(HostObject)

    Steinberg::int32 PLUGIN_API getEventCount() SMTG_OVERRIDE { return 0; }
    Steinberg::tresult PLUGIN_API getEvent(Steinberg::int32, Steinberg::Vst::Event&) SMTG_OVERRIDE {
        return Steinberg::kResultFalse;
    }
    Steinberg::tresult PLUGIN_API addEvent(Steinberg::Vst::Event&) SMTG_OVERRIDE {
        // Accepted and discarded: returning an error here makes plugins log or retry.
        return Steinberg::kResultOk;
    }
};

}  // namespace thedaw::vst3
