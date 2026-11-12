#ifndef PATCH_DIAL_H
#define PATCH_DIAL_H

#ifdef __cplusplus
extern "C" {
#endif

/** Called with +1 per clockwise click and -1 per anticlockwise click. */
typedef void (*patch_dial_cb_t)(int delta, void *user);

/** Start reading the rotary dial (quadrature on two GPIOs, hardware pulse counter). */
void patch_dial_init(patch_dial_cb_t cb, void *user);

#ifdef __cplusplus
}
#endif

#endif
