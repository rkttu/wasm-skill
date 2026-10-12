#include <stdint.h>

int32_t clamp_i32(int32_t value, int32_t minimum, int32_t maximum) {
    if (value < minimum) return minimum;
    if (value > maximum) return maximum;
    return value;
}

int64_t sum_i64(int64_t a, int64_t b) {
    return a + b;
}

double mean_f64(double a, double b) {
    return a / 2.0 + b / 2.0;
}
