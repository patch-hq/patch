idf_component_register(
    SRCS "patch_dial.c"
    INCLUDE_DIRS "include"
    PRIV_REQUIRES esp_driver_pcnt esp_driver_gpio log freertos
)
