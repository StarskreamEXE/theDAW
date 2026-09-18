cmake_minimum_required(VERSION 3.21)
project(thedaw_vst_host LANGUAGES CXX)

# The VST3 layer (src/vst3) is built by its own ticket. Default ON when it is
# present, so a fresh clone with the layer checked out builds the real host and a
# tree without it still builds and runs the null-plugin path.
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/src/vst3/CMakeLists.txt")
    set(THEDAW_VST3_DEFAULT ON)
else()
    set(THEDAW_VST3_DEFAULT OFF)
endif()

option(THEDAW_VST3 "Build and link the VST3 hosting layer" ${THEDAW_VST3_DEFAULT})
option(THEDAW_WERROR "Treat compiler warnings as errors" ON)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Static CRT: the backend spawns this binary from anywhere, so it must not need
# a redistributable next to it.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

add_executable(thedaw-vst-host
    src/main.cpp
    src/engine/AudioFrame.cpp
    src/engine/MessageLoop.cpp
    src/engine/NullPlugin.cpp
    src/engine/Render.cpp
    src/engine/SelfTest.cpp
    src/engine/Session.cpp
    src/net/WsFrame.cpp
    src/net/WsServer.cpp
    src/util/Args.cpp
    src/util/AtomicFile.cpp
    src/util/Base64.cpp
    src/util/Json.cpp
    src/util/Log.cpp
    src/util/SehGuard.cpp
    src/util/Sha1.cpp
    src/util/StringUtil.cpp
    src/util/Wav.cpp
)

target_include_directories(thedaw-vst-host PRIVATE src)

target_compile_definitions(thedaw-vst-host PRIVATE
    UNICODE
    _UNICODE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    _CRT_SECURE_NO_WARNINGS
)

if(MSVC)
    target_compile_options(thedaw-vst-host PRIVATE
        /W4
        /permissive-
        /Zc:__cplusplus
        /Zc:preprocessor
        /EHsc
        /utf-8
        $<$<CONFIG:Release>:/O2>
        $<$<CONFIG:Release>:/GL>
    )
    if(THEDAW_WERROR)
        target_compile_options(thedaw-vst-host PRIVATE /WX)
    endif()
    target_link_options(thedaw-vst-host PRIVATE
        $<$<CONFIG:Release>:/LTCG>
        $<$<CONFIG:Release>:/OPT:REF>
        $<$<CONFIG:Release>:/OPT:ICF>
    )
endif()

if(THEDAW_VST3)
    if(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/src/vst3/CMakeLists.txt")
        message(FATAL_ERROR
            "THEDAW_VST3=ON but src/vst3/CMakeLists.txt does not exist. "
            "Configure with -DTHEDAW_VST3=OFF to build the engine alone.")
    endif()
    add_subdirectory(src/vst3)
    target_link_libraries(thedaw-vst-host PRIVATE thedaw_vst3)
    target_compile_definitions(thedaw-vst-host PRIVATE THEDAW_VST3_ENABLED=1)
else()
    target_sources(thedaw-vst-host PRIVATE src/vst3_stub/Vst3Stub.cpp)
    target_compile_definitions(thedaw-vst-host PRIVATE THEDAW_VST3_ENABLED=0)
endif()

target_link_libraries(thedaw-vst-host PRIVATE
    ws2_32
    shell32
    ole32
    oleaut32
    user32
)

set_target_properties(thedaw-vst-host PROPERTIES OUTPUT_NAME "thedaw-vst-host")
