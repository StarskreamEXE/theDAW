# theDAW: Platform Overview

theDAW by GANTASMO is a free, open-source, local-first Digital Audio Workstation (DAW), DJ environment, VJ performance engine, and creative AI studio distributed via Pinokio and GitHub. It provides a local environment for AI music generation, stem separation, waveform editing, studio mastering, score engraving, lyric structural analysis, and live performance.

Designed to run on personal consumer hardware, theDAW brings generative models and audio processing into one application. Artists can work offline once the required software and models are installed. Local generation has no artificial usage cap, and processing does not require sending audio to an online service. Hardware capacity determines how much can run and how quickly.

Creative sovereignty includes continued access to the tools used to make the work. Artists can keep their recordings and production environment on their own machines, without a recurring subscription maintaining that access. Local model training also allows personal audio to remain private. The application's source code is available for users who want to modify it.

A producer can use theDAW to finish recorded music without generating any audio. An artist working with generative models has the editing tools needed to develop the output further. The same environment supports live remixing and audio-reactive visuals, including control through physical movement. These capabilities are included in the free application; optional cloud services have their own access requirements.

## 1. Generative audio

- **Stable Audio 3:** Generates stereo audio locally from text prompts. Artists can also work from existing audio and regenerate selected regions, allowing a section of a recording to be changed while retaining the surrounding material.

- **Magenta RealTime 2, NVIDIA port:** Provides streaming generative audio that can be steered during playback. An artist can influence the stream with MIDI notes or a reference clip. Support for distributing model memory across multiple GPUs expands the available hardware configurations.

- **Chimera clip fusion:** Analyzes the tempo and key of multiple clips, using their beat grids to assemble the material. Stable Audio then regenerates the joins. A producer could bring together sections recorded at different tempos and create new transitions between them, continuing to work with the resulting audio afterward.

- **Multiple LoRA adapters:** LoRAs are adapters that influence a model's output without replacing the whole model. Several can be loaded together, with independent controls over their strength and where they apply during generation. Custom adapters can be trained locally through UNDERFIT.

- **Optional cloud generation:** Lyria 3 Pro and Suno integrations provide additional generation backends. Selecting a cloud backend sends the generation request to that service and requires a connection.

## 2. Audio processing and mastering

- **Stem separation:** Demucs separates a mixed recording into instrument parts. LARSNET further divides the drum track into individual percussion components, allowing work on a kick or snare independently of the rest of the kit. This gives artists access to parts within a recording even when they do not have its original multitrack session.

- **CHOP-UP mastering rack:** A modular processing rack with multiband compression, linear-phase EQ, transient shaping, tape saturation, and target-matching macros. A producer can build a processing chain around the recording and adjust its individual stages.

- **Delivery and loudness checks:** Export tools assess the encoded result against the selected delivery targets and provide dithering options. Checking after encoding makes it possible to examine the file that will actually be delivered.

- **Restoration and neural effects:** Noise reduction and dereverberation address problems in recordings, alongside spectral repair and super-resolution reconstruction. Creative modules include SpectraMorph, TimbreForge, PromptFX, TokenSynth, and GrainLab.

## 3. Lyric writing and structural analysis

The lyric notebook can be used before there is a recording to attach it to. Writers can examine the construction of a verse as it develops, with analysis displayed alongside the draft.

- **Lyric notebook:** Syllable counts and rhyme-class indicators appear beside the lines during writing. A change to a phrase can be examined in the context of the surrounding verse.

- **STUDY:** Marks rhyme schemes and relationships within the text, including near rhymes and multisyllabic rhymes that extend across lines. It also examines devices such as alliteration and enjambment. Possible double meanings can be explored through an optional model-assisted analysis.

- **Rhyme graphs:** ARC and RING views display connections between words and passages. A rhyme introduced in one line can be followed to its recurrence later in the verse. The graphs export as SVG or PNG for use outside the application.

## 4. MIDI and notation

- **MIDI piano roll:** Supports pitch-bend editing and variable time signatures, with polymeter lanes for parts that use different meters. Pickup bars and chord arpeggiators provide further arrangement controls.

- **Audio-to-MIDI:** Converts a sung melody or audio sample into MIDI notes for editing. An artist can sketch a part with their voice and use the resulting notes to develop an instrumental arrangement.

- **DRAW canvas:** Maps freehand strokes and their positions to generative sound controls. The canvas can be used as a performance surface, with changes to the drawing affecting the sound.

- **Score engraving:** Produces notation from MIDI, with MusicXML and ABC exports for further work in notation software. PDF and SVG provide printable or shareable scores. Separate exports support Unity notechart packages and Beat Saber levels, so an artist's composition can also become a playable rhythm-game chart.

- **Play-along views:** PAGE follows an engraved score, while STRIP presents a continuous staff. CHORDS displays fretboard diagrams; HIGHWAY uses notes scrolling toward a target line. Audio delay calibration aligns the visual timing with the playback device.

## 5. Live performance

- **Dual-deck DJ environment:** Includes beat synchronization and key lock, with hot cues and automix. Stem solo and mute controls make individual parts available during a set. A DJ can keep the bass from one recording under the percussion from another, with effects applied during the mix.

- **VJ-9000:** Generates audio-reactive visuals using shaders, depth clouds, cymatic patterns, video-to-ASCII, and volumetric video effects. A live camera image can become a field of characters that changes with the music, bringing the room itself into the performance.

- **Video sources and physical control:** Supports camera feeds over the local network and screen captures. Companion application theDAW-XR adds Meta Quest 3 integration, while Audima Sway support provides motion input for performance controls. A performer can combine live video with generated visuals and manipulate the set through movement.

## 6. Specialized workspaces

- **UNDERFIT:** Trains custom LoRA adapters from personal audio on a local GPU. An artist could train an adapter using recordings of their own ensemble, then use it to influence generated material. Training and subsequent local generation can both take place without uploading the source recordings.

- **LOOM and the shard index:** Cuts stems into beat-aligned fragments that become the material for continuously changing loop structures. A recording can supply pieces for a generative arrangement, with the loop relationships changing as it plays.

- **LEARN:** Displays the lineage and remix history of audio in a navigable graph. Artists can trace a piece back to the recordings it came from, including intermediate versions and stem separations.

- **FOUNDRY:** A drag-and-drop editor for custom plugin interfaces. Designs are packaged as `.gan` web-plugins that can load in theDAW's effects chain. Artists can arrange controls around the way they intend to use a plugin.

- **TOUR:** Supports venue discovery and tour planning, with venue capacities and booking contacts. Route information includes drive times and EV charging stops.

- **Integrated assistant:** Searches the documentation and operates supported interface controls through text commands. Local backends include Ollama and LM Studio; cloud model backends are also supported.

## 7. Existing projects and hardware

Project import supports formats from applications including Ableton Live, Reaper, FL Studio, Audacity, Adobe Audition, Bitwig, and Resolume. The extent of the transfer depends on the source format and the contents of the project.

Controller Vision generates control layouts from photographs of hardware knob and fader arrangements supplied through a mobile web interface. The layout of a physical controller can provide the starting point for its software interface.

theDAW is in active development for Windows, Linux, and macOS. Larger local generation models require a supported NVIDIA GPU. Smaller model configurations are available for CPU and Apple Silicon, with requirements varying by tool.

The [GitHub repository](https://github.com/gantasmo/theDAW) provides installation instructions and the Pinokio launcher. Downloads are available on the [releases page](https://github.com/gantasmo/theDAW/releases).
