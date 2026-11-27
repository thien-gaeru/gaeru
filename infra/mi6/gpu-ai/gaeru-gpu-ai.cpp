#include <MNN/Interpreter.hpp>
#include <MNN/Tensor.hpp>
#include "httplib.h"
#include "json.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <fstream>
#include <memory>
#include <mutex>
#include <sched.h>
#include <sstream>
#include <string>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>
#include <vector>

using json = nlohmann::json;

namespace {

constexpr int RMBG_SIZE = 320;
constexpr int RMBG_HW = RMBG_SIZE * RMBG_SIZE;

std::atomic<bool> g_stop{false};
volatile sig_atomic_t g_shutdown_requested = 0;
std::mutex g_gpu_mutex;
std::mutex g_cpu_rmbg_mutex;
std::mutex g_child_mutex;
std::mutex g_thermal_mutex;
pid_t g_llama_pid = -1;

std::atomic<uint64_t> g_rmbg_calls{0};
std::atomic<uint64_t> g_rmbg_gpu_calls{0};
std::atomic<uint64_t> g_rmbg_cpu_calls{0};
std::atomic<uint64_t> g_rmbg_total_ms{0};
std::atomic<uint64_t> g_embed_calls{0};
std::atomic<uint64_t> g_embed_total_ms{0};
std::atomic<uint64_t> g_errors{0};
std::atomic<uint64_t> g_thermal_sheds{0};
std::atomic<int> g_embed_inflight{0};
std::atomic<int> g_rmbg_inflight{0};
std::atomic<bool> g_mnn_ready{false};
std::atomic<bool> g_mnn_cpu_ready{false};
std::atomic<bool> g_embed_ready{false};

std::string env_or(const char *k, const char *def) {
    const char *v = std::getenv(k);
    return (v && *v) ? std::string(v) : std::string(def);
}

int env_int(const char *k, int def) {
    const char *v = std::getenv(k);
    if (!v || !*v) return def;
    return std::atoi(v);
}

std::string read_text_file(const std::string &path) {
    std::ifstream f(path);
    if (!f) return "";
    std::ostringstream ss;
    ss << f.rdbuf();
    std::string s = ss.str();
    while (!s.empty() && (s.back() == '\n' || s.back() == '\r' || s.back() == ' ')) {
        s.pop_back();
    }
    return s;
}

long read_rss_kb(pid_t pid) {
    std::string p = (pid <= 0) ? "/proc/self/status" : ("/proc/" + std::to_string(pid) + "/status");
    std::ifstream f(p);
    std::string line;
    while (std::getline(f, line)) {
        if (line.rfind("VmRSS:", 0) == 0) {
            return std::strtol(line.c_str() + 6, nullptr, 10);
        }
    }
    return 0;
}

double normalize_temp_c(const std::string &raw) {
    if (raw.empty()) return -1.0;
    double v = std::strtod(raw.c_str(), nullptr);
    if (v >= 1000.0) return v / 1000.0;
    if (v >= 120.0) return v / 10.0;
    return v;
}

double read_kgsl_temp_c() {
    return normalize_temp_c(read_text_file("/sys/class/kgsl/kgsl-3d0/temp"));
}

double read_soc_max_temp_c() {
    double max_c = -1.0;
    DIR *dir = opendir("/sys/class/thermal");
    if (!dir) return max_c;
    struct dirent *ent = nullptr;
    while ((ent = readdir(dir)) != nullptr) {
        if (std::strncmp(ent->d_name, "thermal_zone", 12) != 0) continue;
        std::string base = std::string("/sys/class/thermal/") + ent->d_name;
        std::string typ = read_text_file(base + "/type");
        if (typ.rfind("tsens_tz_sensor", 0) != 0) continue;
        double c = normalize_temp_c(read_text_file(base + "/temp"));
        if (c > max_c) max_c = c;
    }
    closedir(dir);
    return max_c;
}

struct ThermalState {
    double gpu_temp_c = -1.0;
    double soc_max_c = -1.0;
    bool throttled = false;
    std::chrono::steady_clock::time_point updated_at{};
};

ThermalState g_thermal_cache;

ThermalState get_thermal_state(double gpu_limit_c, double soc_limit_c) {
    auto now = std::chrono::steady_clock::now();
    std::lock_guard<std::mutex> lock(g_thermal_mutex);
    if (g_thermal_cache.updated_at.time_since_epoch().count() == 0 ||
        std::chrono::duration_cast<std::chrono::milliseconds>(now - g_thermal_cache.updated_at).count() >= 1500) {
        g_thermal_cache.gpu_temp_c = read_kgsl_temp_c();
        g_thermal_cache.soc_max_c = read_soc_max_temp_c();
        g_thermal_cache.throttled =
            (g_thermal_cache.gpu_temp_c >= gpu_limit_c) ||
            (g_thermal_cache.soc_max_c >= soc_limit_c);
        g_thermal_cache.updated_at = now;
    }
    return g_thermal_cache;
}

json read_gpu_telemetry() {
    std::string clk = read_text_file("/sys/class/kgsl/kgsl-3d0/gpuclk");
    std::string busy = read_text_file("/sys/class/kgsl/kgsl-3d0/gpubusy");
    double clk_mhz = clk.empty() ? 0.0 : std::strtod(clk.c_str(), nullptr) / 1e6;
    double busy_pct = 0.0;
    if (!busy.empty()) {
        double a = 0, b = 0;
        std::istringstream iss(busy);
        if ((iss >> a >> b) && b > 0.0) {
            busy_pct = std::min(100.0, std::max(0.0, (a / b) * 100.0));
        }
    }
    return json{
        {"clk_mhz", std::round(clk_mhz * 10.0) / 10.0},
        {"busy_pct", std::round(busy_pct * 100.0) / 100.0},
        {"temp_c", std::round(read_kgsl_temp_c() * 10.0) / 10.0},
    };
}

class MnnRmbgEngine {
public:
    bool init(const std::string &model_path,
              const std::string &cache_path,
              MNNForwardType forward_type,
              int num_threads,
              MNN::BackendConfig::PrecisionMode precision,
              bool use_gpu_image = true) {
        net_.reset(MNN::Interpreter::createFromFile(model_path.c_str()));
        if (!net_) return false;
        if (!cache_path.empty()) {
            net_->setCacheFile(cache_path.c_str(), 128);
        }

        MNN::ScheduleConfig cfg;
        cfg.type = forward_type;
        if (forward_type == MNN_FORWARD_OPENCL) {
            cfg.mode = MNN_GPU_TUNING_NORMAL |
                       (use_gpu_image ? MNN_GPU_MEMORY_IMAGE : MNN_GPU_MEMORY_BUFFER);
        }
        cfg.numThread = num_threads;
        bcfg_.precision = precision;
        bcfg_.power = MNN::BackendConfig::Power_High;
        if (forward_type == MNN_FORWARD_CPU) {
            bcfg_.memory = MNN::BackendConfig::Memory_Low;
        }
        cfg.backendConfig = &bcfg_;

        sess_ = net_->createSession(cfg);
        if (!sess_) return false;
        in_ = net_->getSessionInput(sess_, nullptr);
        out_ = net_->getSessionOutput(sess_, nullptr);
        if (!in_ || !out_) return false;

        net_->resizeTensor(in_, {1, 3, RMBG_SIZE, RMBG_SIZE});
        net_->resizeSession(sess_);
        if (!cache_path.empty()) {
            net_->updateCacheFile(sess_);
        }

        host_in_ = std::make_unique<MNN::Tensor>(in_, MNN::Tensor::CAFFE);
        host_out_ = std::make_unique<MNN::Tensor>(out_, MNN::Tensor::CAFFE);

        std::fill_n(host_in_->host<float>(), 3 * RMBG_HW, 0.0f);
        in_->copyFromHostTensor(host_in_.get());
        net_->runSession(sess_);
        out_->copyToHostTensor(host_out_.get());
        if (!cache_path.empty()) {
            net_->updateCacheFile(sess_);
        }
        return true;
    }

    struct Result {
        std::vector<uint8_t> alpha;
        float vmin = 0.0f;
        float vmax = 0.0f;
        float fg_ratio = 0.0f;
        double ms = 0.0;
    };

    Result run(const uint8_t *rgb) {
        Result res;
        res.alpha.assign(RMBG_HW, 0);

        const float mean[3] = {0.485f, 0.456f, 0.406f};
        const float inv_std[3] = {1.0f / 0.229f, 1.0f / 0.224f, 1.0f / 0.225f};
        uint8_t max_px = 1;
        for (int i = 0; i < RMBG_HW * 3; ++i) {
            if (rgb[i] > max_px) max_px = rgb[i];
        }
        const float inv_max = 1.0f / static_cast<float>(max_px);

        float *dst = host_in_->host<float>();
        for (int i = 0; i < RMBG_HW; ++i) {
            dst[0 * RMBG_HW + i] = (rgb[i * 3 + 0] * inv_max - mean[0]) * inv_std[0];
            dst[1 * RMBG_HW + i] = (rgb[i * 3 + 1] * inv_max - mean[1]) * inv_std[1];
            dst[2 * RMBG_HW + i] = (rgb[i * 3 + 2] * inv_max - mean[2]) * inv_std[2];
        }

        auto t0 = std::chrono::steady_clock::now();
        in_->copyFromHostTensor(host_in_.get());
        net_->runSession(sess_);
        out_->copyToHostTensor(host_out_.get());
        auto t1 = std::chrono::steady_clock::now();
        res.ms = std::chrono::duration<double, std::milli>(t1 - t0).count();

        const float *po = host_out_->host<float>();
        float vmin = 1e9f, vmax = -1e9f;
        for (int i = 0; i < RMBG_HW; ++i) {
            float v = po[i];
            if (!std::isfinite(v)) continue;
            if (v < vmin) vmin = v;
            if (v > vmax) vmax = v;
        }
        if (vmin > vmax) { vmin = 0.0f; vmax = 0.0f; }
        res.vmin = vmin;
        res.vmax = vmax;

        if (vmax < 0.25f || (vmax - vmin) < 0.15f) {
            res.fg_ratio = 0.0f;
            return res;
        }

        const float inv_span = 1.0f / (vmax - vmin);
        int fg_count = 0;
        for (int i = 0; i < RMBG_HW; ++i) {
            float v = std::clamp((po[i] - vmin) * inv_span, 0.0f, 1.0f);
            uint8_t a = static_cast<uint8_t>(v * 255.0f + 0.5f);
            res.alpha[i] = a;
            if (a >= 128) fg_count++;
        }
        res.fg_ratio = static_cast<float>(fg_count) / static_cast<float>(RMBG_HW);
        return res;
    }

private:
    std::unique_ptr<MNN::Interpreter> net_;
    MNN::BackendConfig bcfg_;
    MNN::Session *sess_ = nullptr;
    MNN::Tensor *in_ = nullptr;
    MNN::Tensor *out_ = nullptr;
    std::unique_ptr<MNN::Tensor> host_in_;
    std::unique_ptr<MNN::Tensor> host_out_;
};

bool parse_cpu_range(const std::string &range_str, cpu_set_t &set) {
    int lo = -1, hi = -1;
    if (std::sscanf(range_str.c_str(), "%d-%d", &lo, &hi) == 2 && lo >= 0 && hi >= lo && hi < CPU_SETSIZE) {
        CPU_ZERO(&set);
        for (int c = lo; c <= hi; ++c) CPU_SET(c, &set);
        return true;
    }
    return false;
}

pid_t spawn_llama_server(const std::string &bin,
                         const std::string &model,
                         int port,
                         int ngl,
                         int threads,
                         int ctx_size,
                         int slots,
                         const std::string &cpu_range,
                         int nice_val) {
    // Pre-build all strings, argv pointers, CPU affinity set, and FD bound BEFORE fork()
    // so the post-fork child executes ONLY async-signal-safe POSIX calls.
    cpu_set_t cpu_set;
    const bool has_cpu_set = !cpu_range.empty() && parse_cpu_range(cpu_range, cpu_set);

    const std::string port_s = std::to_string(port);
    const std::string ngl_s = std::to_string(ngl);
    const std::string thr_s = std::to_string(threads);
    const std::string ctx_s = std::to_string(ctx_size);
    const std::string slots_s = std::to_string(slots);

    std::vector<char *> argv = {
        const_cast<char *>(bin.c_str()),
        const_cast<char *>("-m"), const_cast<char *>(model.c_str()),
        const_cast<char *>("--host"), const_cast<char *>("127.0.0.1"),
        const_cast<char *>("--port"), const_cast<char *>(port_s.c_str()),
        const_cast<char *>("-c"), const_cast<char *>(ctx_s.c_str()),
        const_cast<char *>("-b"), const_cast<char *>(ctx_s.c_str()),
        const_cast<char *>("-ub"), const_cast<char *>(ctx_s.c_str()),
        const_cast<char *>("-np"), const_cast<char *>(slots_s.c_str()),
        const_cast<char *>("-ngl"), const_cast<char *>(ngl_s.c_str()),
        const_cast<char *>("-t"), const_cast<char *>(thr_s.c_str()),
        const_cast<char *>("-tb"), const_cast<char *>(thr_s.c_str()),
        const_cast<char *>("--pooling"), const_cast<char *>("mean"),
        const_cast<char *>("--embedding"),
        const_cast<char *>("--no-warmup"),
        const_cast<char *>("--no-webui"),
        const_cast<char *>("--log-disable"),
        nullptr
    };

    long max_fd = sysconf(_SC_OPEN_MAX);
    if (max_fd < 3 || max_fd > 1024) max_fd = 1024;
    const char *bin_cstr = bin.c_str();
    char *const *argv_ptr = argv.data();

    pid_t pid = fork();
    if (pid == 0) {
        prctl(PR_SET_PDEATHSIG, SIGTERM);
        if (nice_val != 0) {
            setpriority(PRIO_PROCESS, 0, nice_val);
        }
        if (has_cpu_set) {
            sched_setaffinity(0, sizeof(cpu_set), &cpu_set);
        }
        for (int fd = 3; fd < static_cast<int>(max_fd); ++fd) {
            ::close(fd);
        }
        execvp(bin_cstr, argv_ptr);
        _exit(127);
    }
    return pid;
}

bool probe_llama_health(int port) {
    httplib::Client cli("127.0.0.1", port);
    cli.set_connection_timeout(1, 0);
    cli.set_read_timeout(1, 0);
    auto r = cli.Get("/health");
    return r && r->status == 200;
}

void stop_llama_child() {
    std::lock_guard<std::mutex> lock(g_child_mutex);
    if (g_llama_pid > 0) {
        kill(g_llama_pid, SIGTERM);
        for (int i = 0; i < 20; ++i) {
            int st = 0;
            if (waitpid(g_llama_pid, &st, WNOHANG) != 0) {
                g_llama_pid = -1;
                return;
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        }
        kill(g_llama_pid, SIGKILL);
        int st = 0;
        waitpid(g_llama_pid, &st, 0);
        g_llama_pid = -1;
    }
}

void signal_handler(int) {
    g_shutdown_requested = 1;
}

struct ScopedInflight {
    std::atomic<int> &counter;
    explicit ScopedInflight(std::atomic<int> &c) : counter(c) { counter.fetch_add(1); }
    ~ScopedInflight() { counter.fetch_sub(1); }
};

} // namespace

int main() {
    std::signal(SIGPIPE, SIG_IGN);
    std::signal(SIGINT, signal_handler);
    std::signal(SIGTERM, signal_handler);

    setenv("GGML_OPENCL_PLATFORM", "QUALCOMM", 0);
    setenv("XDG_CACHE_HOME", "/var/cache/gaeru-gpu-ai", 0);

    const std::string host = env_or("GAERU_GPU_AI_HOST", "127.0.0.1");
    const int port = env_int("GAERU_GPU_AI_PORT", 3100);
    const int llama_port = env_int("GAERU_GPU_AI_LLAMA_PORT", 3101);
    const std::string rmbg_model = env_or("GAERU_RMBG_MODEL", "/storage/ai-models/u2netp_fp16.mnn");
    const std::string rmbg_gpu_mem = env_or("GAERU_RMBG_GPU_MEM", "image");
    const bool use_gpu_image = (rmbg_gpu_mem != "buffer");
    const std::string default_cache = use_gpu_image
        ? "/var/cache/gaeru-gpu-ai/u2netp_fp16_img.mnncache"
        : "/var/cache/gaeru-gpu-ai/u2netp_fp16.mnncache";
    const std::string rmbg_cache = env_or("GAERU_RMBG_CACHE", default_cache.c_str());
    const std::string embed_model = env_or("GAERU_EMBED_MODEL", "/storage/ai-models/paraphrase-multilingual-MiniLM-L12-118M-v2-Q8_0.gguf");
    const std::string llama_bin = env_or("GAERU_LLAMA_SERVER_BIN", "/storage/gpu-ai-build/llama.cpp/build-opencl/bin/llama-server");

    // Optimized Tier 1 + Tier 2 defaults (empirically verified on Mi 6 Snapdragon 835):
    // - RMBG: Adreno 540 OpenCL IMAGE mode (~257ms, -160MB RAM by disabling redundant CPU overflow)
    // - Embed: Kryo 280 BIG cores 4-7, ctx=511 (matches n_ctx_train), slots=1, nice=2, keep-alive proxy
    const int embed_ngl = std::max(0, env_int("GAERU_EMBED_NGL", 0));
    const int embed_threads = std::clamp(env_int("GAERU_EMBED_THREADS", 4), 1, 8);
    const int embed_ctx = std::clamp(env_int("GAERU_EMBED_CTX", 511), 256, 2048);
    const int embed_slots = std::clamp(env_int("GAERU_EMBED_SLOTS", 1), 1, 4);
    const std::string embed_cpu_range = env_or("GAERU_EMBED_CPU_RANGE", "4-7");
    const int embed_nice = std::clamp(env_int("GAERU_EMBED_NICE", 2), -5, 19);
    const int rmbg_cpu_threads = std::clamp(env_int("GAERU_RMBG_CPU_THREADS", 0), 0, 8);
    const int rmbg_max_inflight = std::clamp(env_int("GAERU_RMBG_MAX_INFLIGHT", 3), 1, 8);
    const int embed_max_inflight = std::clamp(env_int("GAERU_EMBED_MAX_INFLIGHT", 4), 1, 16);
    const int http_threads = std::clamp(env_int("GAERU_HTTP_THREADS", 12), 8, 24);
    const double thermal_gpu_c = static_cast<double>(env_int("GAERU_THERMAL_GPU_C", 58));
    const double thermal_soc_c = static_cast<double>(env_int("GAERU_THERMAL_SOC_C", 56));

    auto t_start = std::chrono::steady_clock::now();

    MnnRmbgEngine mnn_gpu;
    if (mnn_gpu.init(rmbg_model, rmbg_cache, MNN_FORWARD_OPENCL, 1, MNN::BackendConfig::Precision_Low, use_gpu_image)) {
        g_mnn_ready = true;
        std::fprintf(stderr, "[gaeru-gpu-ai] MNN u2netp_fp16 OpenCL (%s) ready (RSS=%ld kB)\n",
                     use_gpu_image ? "IMAGE" : "BUFFER", read_rss_kb(0));
    } else {
        std::fprintf(stderr, "[gaeru-gpu-ai] ERROR: failed to init MNN GPU model %s\n", rmbg_model.c_str());
    }

    // Only init CPU RMBG when explicitly requested OR as fallback if OpenCL GPU failed
    MnnRmbgEngine mnn_cpu;
    const int effective_cpu_threads = (!g_mnn_ready.load() && rmbg_cpu_threads == 0) ? 4 : rmbg_cpu_threads;
    if (effective_cpu_threads > 0 &&
        mnn_cpu.init(rmbg_model, "", MNN_FORWARD_CPU, effective_cpu_threads, MNN::BackendConfig::Precision_Low, false)) {
        g_mnn_cpu_ready = true;
        std::fprintf(stderr, "[gaeru-gpu-ai] MNN u2netp CPU fallback ready (threads=%d, RSS=%ld kB)\n",
                     effective_cpu_threads, read_rss_kb(0));
    }

    std::thread supervisor([&]() {
        while (!g_stop.load() && !g_shutdown_requested) {
            pid_t pid = -1;
            {
                std::lock_guard<std::mutex> lock(g_child_mutex);
                pid = spawn_llama_server(llama_bin, embed_model, llama_port,
                                         embed_ngl, embed_threads, embed_ctx, embed_slots,
                                         embed_cpu_range, embed_nice);
                g_llama_pid = pid;
            }
            if (pid <= 0) {
                g_embed_ready = false;
                std::this_thread::sleep_for(std::chrono::seconds(3));
                continue;
            }
            while (!g_stop.load() && !g_shutdown_requested) {
                int st = 0;
                pid_t wp = waitpid(pid, &st, WNOHANG);
                if (wp == pid || wp < 0) {
                    std::lock_guard<std::mutex> lock(g_child_mutex);
                    if (g_llama_pid == pid) g_llama_pid = -1;
                    g_embed_ready = false;
                    break;
                }
                g_embed_ready = probe_llama_health(llama_port);
                std::this_thread::sleep_for(std::chrono::seconds(2));
            }
            if (!g_stop.load() && !g_shutdown_requested) {
                std::fprintf(stderr, "[gaeru-gpu-ai] llama-server exited, restarting in 2s...\n");
                std::this_thread::sleep_for(std::chrono::seconds(2));
            }
        }
    });

    httplib::Server svr;
    svr.new_task_queue = [http_threads] { return new httplib::ThreadPool(http_threads); };
    svr.set_payload_max_length(4 * 1024 * 1024);
    svr.set_read_timeout(30, 0);
    svr.set_write_timeout(30, 0);
    svr.set_keep_alive_max_count(200);

    svr.Get("/health", [&](const httplib::Request &, httplib::Response &res) {
        pid_t child_pid = -1;
        {
            std::lock_guard<std::mutex> lock(g_child_mutex);
            child_pid = g_llama_pid;
        }
        long rss_self = read_rss_kb(0);
        long rss_embed = (child_pid > 0) ? read_rss_kb(child_pid) : 0;
        uint64_t rc = g_rmbg_calls.load();
        uint64_t ec = g_embed_calls.load();
        auto up = std::chrono::duration_cast<std::chrono::seconds>(
            std::chrono::steady_clock::now() - t_start).count();
        auto th = get_thermal_state(thermal_gpu_c, thermal_soc_c);

        const bool rmbg_any = g_mnn_ready.load() || g_mnn_cpu_ready.load();
        const std::string rmbg_backend = (g_mnn_ready.load() && g_mnn_cpu_ready.load())
            ? "gpu-opencl+cpu-overflow"
            : (g_mnn_ready.load() ? (use_gpu_image ? "gpu-opencl-image" : "gpu-opencl-buffer")
                                  : (g_mnn_cpu_ready.load() ? "cpu-neon" : "none"));
        const std::string embed_backend = (embed_ngl > 0)
            ? ("gpu-opencl-ngl" + std::to_string(embed_ngl))
            : ("cpu-neon-big-t" + std::to_string(embed_threads));

        std::string embed_model_base = embed_model;
        auto slash = embed_model_base.find_last_of('/');
        if (slash != std::string::npos) embed_model_base = embed_model_base.substr(slash + 1);

        json body = {
            {"ok", rmbg_any && g_embed_ready.load()},
            {"service", "gaeru-gpu-ai"},
            {"mode", (embed_ngl == 0 && g_mnn_ready.load()) ? "hybrid-cpu-gpu-v2" : "gpu-primary"},
            {"device", "QUALCOMM Adreno(TM) 540 OpenCL 2.0 + Kryo 280 BIG NEON"},
            {"ready", {{"rmbg", rmbg_any}, {"rmbg_gpu", g_mnn_ready.load()}, {"rmbg_cpu", g_mnn_cpu_ready.load()}, {"embed", g_embed_ready.load()}}},
            {"backends", {
                {"rmbg", rmbg_backend},
                {"rmbg_gpu_mem", use_gpu_image ? "image" : "buffer"},
                {"embed", embed_backend},
                {"embed_ngl", embed_ngl},
                {"embed_threads", embed_threads},
                {"embed_ctx", embed_ctx},
                {"embed_slots", embed_slots},
                {"embed_cpu_range", embed_cpu_range},
                {"embed_nice", embed_nice},
                {"rmbg_cpu_threads", effective_cpu_threads},
                {"rmbg_max_inflight", rmbg_max_inflight},
                {"embed_max_inflight", embed_max_inflight},
                {"http_threads", http_threads}
            }},
            {"models", {
                {"rmbg", "u2netp_fp16.mnn"},
                {"embed", embed_model_base}
            }},
            {"rss_kb", {{"rmbg", rss_self}, {"embed", rss_embed}, {"total", rss_self + rss_embed}}},
            {"gpu", read_gpu_telemetry()},
            {"thermal", {
                {"gpu_temp_c", std::round(th.gpu_temp_c * 10.0) / 10.0},
                {"soc_max_c", std::round(th.soc_max_c * 10.0) / 10.0},
                {"gpu_limit_c", thermal_gpu_c},
                {"soc_limit_c", thermal_soc_c},
                {"throttled", th.throttled},
                {"sheds", g_thermal_sheds.load()},
                {"embed_in_flight", g_embed_inflight.load()},
                {"rmbg_in_flight", g_rmbg_inflight.load()}
            }},
            {"stats", {
                {"rmbg_calls", rc},
                {"rmbg_gpu_calls", g_rmbg_gpu_calls.load()},
                {"rmbg_cpu_calls", g_rmbg_cpu_calls.load()},
                {"rmbg_avg_ms", rc ? static_cast<double>(g_rmbg_total_ms.load()) / rc : 0.0},
                {"embed_calls", ec},
                {"embed_avg_ms", ec ? static_cast<double>(g_embed_total_ms.load()) / ec : 0.0},
                {"errors", g_errors.load()}
            }},
            {"uptime_s", up}
        };
        res.set_content(body.dump(), "application/json");
    });

    svr.Post("/v1/remove-bg", [&](const httplib::Request &req, httplib::Response &res) {
        const bool gpu_ready = g_mnn_ready.load();
        const bool cpu_ready = g_mnn_cpu_ready.load();
        if (!gpu_ready && !cpu_ready) {
            g_errors++;
            res.status = 503;
            res.set_content("{\"error\":\"rmbg engine not ready\"}", "application/json");
            return;
        }
        int w = req.has_param("w") ? std::atoi(req.get_param_value("w").c_str()) : RMBG_SIZE;
        int h = req.has_param("h") ? std::atoi(req.get_param_value("h").c_str()) : RMBG_SIZE;
        if (w != RMBG_SIZE || h != RMBG_SIZE || req.body.size() != static_cast<size_t>(RMBG_HW * 3)) {
            g_errors++;
            res.status = 400;
            res.set_content("{\"error\":\"expected 320x320 raw RGB bytes (307200 bytes)\"}", "application/json");
            return;
        }
        const bool is_bg =
            (req.has_header("X-AI-Priority") && req.get_header_value("X-AI-Priority") == "background") ||
            (req.has_param("priority") && req.get_param_value("priority") == "background");
        if (is_bg) {
            auto th = get_thermal_state(thermal_gpu_c, thermal_soc_c);
            if (th.throttled || g_rmbg_inflight.load() >= 1) {
                g_thermal_sheds++;
                res.status = 503;
                res.set_content("{\"error\":\"thermal_or_busy_shed\"}", "application/json");
                return;
            }
        } else if (g_rmbg_inflight.load() >= rmbg_max_inflight) {
            g_thermal_sheds++;
            res.status = 503;
            res.set_content("{\"error\":\"rmbg_queue_full\"}", "application/json");
            return;
        }

        ScopedInflight guard(g_rmbg_inflight);
        const uint8_t *rgb = reinterpret_cast<const uint8_t *>(req.body.data());
        MnnRmbgEngine::Result out;
        bool used_gpu = false;

        if (gpu_ready) {
            std::lock_guard<std::mutex> gpu_lock(g_gpu_mutex);
            used_gpu = true;
            out = mnn_gpu.run(rgb);
        } else {
            std::lock_guard<std::mutex> cpu_lock(g_cpu_rmbg_mutex);
            used_gpu = false;
            out = mnn_cpu.run(rgb);
        }

        g_rmbg_calls++;
        if (used_gpu) g_rmbg_gpu_calls++;
        else g_rmbg_cpu_calls++;
        g_rmbg_total_ms += static_cast<uint64_t>(out.ms + 0.5);

        char buf[64];
        std::snprintf(buf, sizeof(buf), "%.1f", out.ms);
        res.set_header("X-Inference-Ms", buf);
        res.set_header("X-Compute-Backend", used_gpu ? (use_gpu_image ? "gpu-opencl-image" : "gpu-opencl-buffer") : "cpu-neon");
        std::snprintf(buf, sizeof(buf), "%.4f", out.vmin);
        res.set_header("X-Raw-Min", buf);
        std::snprintf(buf, sizeof(buf), "%.4f", out.vmax);
        res.set_header("X-Raw-Max", buf);
        std::snprintf(buf, sizeof(buf), "%.4f", out.fg_ratio);
        res.set_header("X-Foreground-Ratio", buf);
        res.set_content(std::string(reinterpret_cast<const char *>(out.alpha.data()), out.alpha.size()),
                        "application/octet-stream");
    });

    auto handle_embed = [&](const httplib::Request &req, httplib::Response &res) {
        if (!g_embed_ready.load()) {
            g_errors++;
            res.status = 503;
            res.set_content("{\"error\":\"embedding engine warming up\"}", "application/json");
            return;
        }
        const bool is_bg =
            (req.has_header("X-AI-Priority") && req.get_header_value("X-AI-Priority") == "background") ||
            (req.has_param("priority") && req.get_param_value("priority") == "background");
        if (is_bg) {
            auto th = get_thermal_state(thermal_gpu_c, thermal_soc_c);
            if (th.throttled || g_embed_inflight.load() >= 1 || g_rmbg_inflight.load() >= 1) {
                g_thermal_sheds++;
                res.status = 503;
                res.set_content("{\"error\":\"thermal_or_busy_shed\"}", "application/json");
                return;
            }
        } else if (g_embed_inflight.load() >= embed_max_inflight) {
            g_thermal_sheds++;
            res.status = 503;
            res.set_content("{\"error\":\"embed_queue_full\"}", "application/json");
            return;
        }

        ScopedInflight guard(g_embed_inflight);
        auto t0 = std::chrono::steady_clock::now();
        httplib::Result proxy_res;
        {
            std::unique_lock<std::mutex> gpu_lock(g_gpu_mutex, std::defer_lock);
            if (embed_ngl > 0) gpu_lock.lock();

            // Thread-local keep-alive HTTP client to eliminate per-request loopback TCP churn
            thread_local std::unique_ptr<httplib::Client> tl_cli;
            if (!tl_cli) {
                tl_cli = std::make_unique<httplib::Client>("127.0.0.1", llama_port);
                tl_cli->set_keep_alive(true);
                tl_cli->set_connection_timeout(2, 0);
                tl_cli->set_read_timeout(30, 0);
            }
            proxy_res = tl_cli->Post("/v1/embeddings", req.body, "application/json");
            if (!proxy_res) {
                // Retry once on fresh connection in case keep-alive socket was recycled
                tl_cli = std::make_unique<httplib::Client>("127.0.0.1", llama_port);
                tl_cli->set_keep_alive(true);
                tl_cli->set_connection_timeout(2, 0);
                tl_cli->set_read_timeout(30, 0);
                proxy_res = tl_cli->Post("/v1/embeddings", req.body, "application/json");
            }
        }
        double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
        if (!proxy_res) {
            g_errors++;
            res.status = 502;
            res.set_content("{\"error\":\"embedding backend unavailable\"}", "application/json");
            return;
        }
        g_embed_calls++;
        g_embed_total_ms += static_cast<uint64_t>(ms + 0.5);
        char buf[32];
        std::snprintf(buf, sizeof(buf), "%.1f", ms);
        res.set_header("X-Inference-Ms", buf);
        res.set_header("X-Compute-Backend", (embed_ngl > 0) ? "gpu-opencl" : "cpu-neon-big");
        res.status = proxy_res->status;
        res.set_content(proxy_res->body, "application/json");
    };

    svr.Post("/v1/embed", handle_embed);
    svr.Post("/v1/embeddings", handle_embed);

    std::fprintf(stderr,
                 "[gaeru-gpu-ai] listening on http://%s:%d (v2: rmbg=OpenCL-%s cpu=%d, embed=ngl=%d t=%d ctx=%d np=%d cpus=%s nice=%d)\n",
                 host.c_str(), port, use_gpu_image ? "IMAGE" : "BUFFER", effective_cpu_threads,
                 embed_ngl, embed_threads, embed_ctx, embed_slots, embed_cpu_range.c_str(), embed_nice);
    std::atomic<bool> listen_exited{false};
    std::thread shutdown_monitor([&]() {
        bool stop_sent = false;
        while (!listen_exited.load()) {
            if (g_shutdown_requested) {
                g_stop.store(true);
                if (!stop_sent && svr.is_running()) {
                    svr.stop();
                    stop_sent = true;
                }
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
    });

    if (!g_shutdown_requested) {
        svr.listen(host, port);
    }

    listen_exited.store(true);
    g_stop.store(true);
    if (shutdown_monitor.joinable()) shutdown_monitor.join();
    stop_llama_child();
    if (supervisor.joinable()) supervisor.join();
    return 0;
}
