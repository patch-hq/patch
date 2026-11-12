// WS2812 LED ring driver for the HA Voice PE.
//
// 12 RGB LEDs on a single GPIO. Driven via the espressif/led_strip component
// using RMT. Renderer thread owns a periodic 60 Hz tick; pattern + colour
// come from patch_led_table given the current pds_state_t.

#ifndef PATCH_LED_H
#define PATCH_LED_H

#include "patch_device_state.h"

#ifdef __cplusplus
extern "C" {
#endif

// Initialise GPIO + RMT. Must be called before patch_led_set().
void patch_led_init(void);

// Set the LED ring to render the pattern for the given device state.
// Called from any task; cheap (just stores the state, the renderer task
// picks it up next tick).
void patch_led_set(pds_state_t state);

/** Show a volume level (0..max) on the ring for ~1.5 s, over the state pattern. */
void patch_led_show_level(int level, int max);

/** Conversation phase. While not NONE it decides the ring, over the device state. */
typedef enum {
    PLED_PHASE_NONE = 0,  // off / the device state's own pattern
    PLED_PHASE_LISTENING, // steady blue: the user is talking
    PLED_PHASE_THINKING,  // amber, rotating: waiting on the agent
    PLED_PHASE_SPEAKING,  // green, breathing: a reply is playing
    PLED_PHASE_FOLLOWUP,  // dim blue, slow breathing: open for a follow-up
} pled_phase_t;

void patch_led_set_phase(pled_phase_t phase);

#ifdef __cplusplus
}
#endif

#endif
