// The HA Voice PE's rotary dial: a quadrature encoder on two GPIOs (the same
// pins as the official ESPHome config). Decoded by the hardware pulse counter
// with a glitch filter, polled by a small task that turns counts into clicks.

#include "patch_dial.h"

#include "driver/pulse_cnt.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

static const char *TAG = "patch-dial";

#ifndef CONFIG_PATCH_DIAL_A_GPIO
#define CONFIG_PATCH_DIAL_A_GPIO 16
#endif
#ifndef CONFIG_PATCH_DIAL_B_GPIO
#define CONFIG_PATCH_DIAL_B_GPIO 18
#endif
#ifndef CONFIG_PATCH_DIAL_COUNTS_PER_CLICK
#define CONFIG_PATCH_DIAL_COUNTS_PER_CLICK 2
#endif

static pcnt_unit_handle_t s_unit;
static patch_dial_cb_t s_cb;
static void *s_user;

static void dial_task(void *arg) {
    (void)arg;
    int carry = 0;
    for (;;) {
        int count = 0;
        pcnt_unit_get_count(s_unit, &count);
        if (count != 0) {
            pcnt_unit_clear_count(s_unit);
            carry += count;
            ESP_LOGD(TAG, "raw count %d carry %d", count, carry);
            while (carry >= CONFIG_PATCH_DIAL_COUNTS_PER_CLICK) {
                carry -= CONFIG_PATCH_DIAL_COUNTS_PER_CLICK;
                if (s_cb) s_cb(+1, s_user);
            }
            while (carry <= -CONFIG_PATCH_DIAL_COUNTS_PER_CLICK) {
                carry += CONFIG_PATCH_DIAL_COUNTS_PER_CLICK;
                if (s_cb) s_cb(-1, s_user);
            }
        }
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}

void patch_dial_init(patch_dial_cb_t cb, void *user) {
    s_cb = cb;
    s_user = user;
    pcnt_unit_config_t unit_cfg = { .low_limit = -1000, .high_limit = 1000 };
    ESP_ERROR_CHECK(pcnt_new_unit(&unit_cfg, &s_unit));
    pcnt_glitch_filter_config_t filt = { .max_glitch_ns = 1000 };
    ESP_ERROR_CHECK(pcnt_unit_set_glitch_filter(s_unit, &filt));
    pcnt_chan_config_t a_cfg = { .edge_gpio_num = CONFIG_PATCH_DIAL_A_GPIO, .level_gpio_num = CONFIG_PATCH_DIAL_B_GPIO };
    pcnt_chan_config_t b_cfg = { .edge_gpio_num = CONFIG_PATCH_DIAL_B_GPIO, .level_gpio_num = CONFIG_PATCH_DIAL_A_GPIO };
    pcnt_channel_handle_t a, b;
    ESP_ERROR_CHECK(pcnt_new_channel(s_unit, &a_cfg, &a));
    ESP_ERROR_CHECK(pcnt_new_channel(s_unit, &b_cfg, &b));
    // Standard x4 quadrature decode.
    ESP_ERROR_CHECK(pcnt_channel_set_edge_action(a, PCNT_CHANNEL_EDGE_ACTION_DECREASE, PCNT_CHANNEL_EDGE_ACTION_INCREASE));
    ESP_ERROR_CHECK(pcnt_channel_set_level_action(a, PCNT_CHANNEL_LEVEL_ACTION_KEEP, PCNT_CHANNEL_LEVEL_ACTION_INVERSE));
    ESP_ERROR_CHECK(pcnt_channel_set_edge_action(b, PCNT_CHANNEL_EDGE_ACTION_INCREASE, PCNT_CHANNEL_EDGE_ACTION_DECREASE));
    ESP_ERROR_CHECK(pcnt_channel_set_level_action(b, PCNT_CHANNEL_LEVEL_ACTION_KEEP, PCNT_CHANNEL_LEVEL_ACTION_INVERSE));
    gpio_set_pull_mode(CONFIG_PATCH_DIAL_A_GPIO, GPIO_PULLUP_ONLY);
    gpio_set_pull_mode(CONFIG_PATCH_DIAL_B_GPIO, GPIO_PULLUP_ONLY);
    ESP_ERROR_CHECK(pcnt_unit_enable(s_unit));
    ESP_ERROR_CHECK(pcnt_unit_clear_count(s_unit));
    ESP_ERROR_CHECK(pcnt_unit_start(s_unit));
    xTaskCreate(dial_task, "patch-dial", 3072, NULL, 4, NULL);
    ESP_LOGI(TAG, "dial ready: a=%d b=%d counts/click=%d", CONFIG_PATCH_DIAL_A_GPIO,
             CONFIG_PATCH_DIAL_B_GPIO, CONFIG_PATCH_DIAL_COUNTS_PER_CLICK);
}
