#define _GNU_SOURCE
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <pthread.h>

#define CL_TARGET_OPENCL_VERSION 300
#define CL_USE_DEPRECATED_OPENCL_1_0_APIS
#define CL_USE_DEPRECATED_OPENCL_1_1_APIS
#define CL_USE_DEPRECATED_OPENCL_1_2_APIS
#define CL_USE_DEPRECATED_OPENCL_2_0_APIS
#include <CL/cl.h>
#include <CL/cl_icd.h>

/* Resolved from libhybris-common.so.1 (GLIBC 2.17 compatible on both host & chroot) */
extern void *hybris_dlopen(const char *filename, int flag);
extern void *hybris_dlsym(void *handle, const char *symbol);

#ifndef RTLD_NOW
#define RTLD_NOW 2
#endif

typedef enum {
    HY_OBJ_PLATFORM = 1,
    HY_OBJ_DEVICE,
    HY_OBJ_CONTEXT,
    HY_OBJ_QUEUE,
    HY_OBJ_MEM,
    HY_OBJ_PROGRAM,
    HY_OBJ_KERNEL,
    HY_OBJ_EVENT,
    HY_OBJ_SAMPLER
} hy_obj_kind_t;

#define HY_MAGIC 0x4859434Cu /* "HYCL" */

typedef struct hy_cl_obj {
    const cl_icd_dispatch *dispatch;
    void *real;
    uint32_t magic;
    hy_obj_kind_t kind;
    int32_t refcnt;
    struct hy_cl_obj *next_real;
    struct hy_cl_obj *next_ptr;
} hy_cl_obj;

#define MAP_BUCKETS 4093
static pthread_mutex_t g_map_mu = PTHREAD_MUTEX_INITIALIZER;
static hy_cl_obj *g_real_buckets[MAP_BUCKETS];
static hy_cl_obj *g_ptr_buckets[MAP_BUCKETS];

static pthread_mutex_t g_init_mu = PTHREAD_MUTEX_INITIALIZER;
static volatile int g_inited = 0;
static void *g_adreno_cl = NULL;
static const cl_icd_dispatch g_icd_dispatch;

/* Adreno raw function pointers */
static struct {
    clGetPlatformIDs_t *clGetPlatformIDs;
    clGetPlatformInfo_t *clGetPlatformInfo;
    clGetDeviceIDs_t *clGetDeviceIDs;
    clGetDeviceInfo_t *clGetDeviceInfo;
    clCreateSubDevices_t *clCreateSubDevices;
    clRetainDevice_t *clRetainDevice;
    clReleaseDevice_t *clReleaseDevice;
    clCreateContext_t *clCreateContext;
    clCreateContextFromType_t *clCreateContextFromType;
    clRetainContext_t *clRetainContext;
    clReleaseContext_t *clReleaseContext;
    clGetContextInfo_t *clGetContextInfo;
    clCreateCommandQueue_t *clCreateCommandQueue;
    clCreateCommandQueueWithProperties_t *clCreateCommandQueueWithProperties;
    clRetainCommandQueue_t *clRetainCommandQueue;
    clReleaseCommandQueue_t *clReleaseCommandQueue;
    clGetCommandQueueInfo_t *clGetCommandQueueInfo;
    clSetCommandQueueProperty_t *clSetCommandQueueProperty;
    clCreateBuffer_t *clCreateBuffer;
    clCreateSubBuffer_t *clCreateSubBuffer;
    clCreateImage_t *clCreateImage;
    clCreateImage2D_t *clCreateImage2D;
    clCreateImage3D_t *clCreateImage3D;
    clRetainMemObject_t *clRetainMemObject;
    clReleaseMemObject_t *clReleaseMemObject;
    clGetSupportedImageFormats_t *clGetSupportedImageFormats;
    clGetMemObjectInfo_t *clGetMemObjectInfo;
    clGetImageInfo_t *clGetImageInfo;
    clSetMemObjectDestructorCallback_t *clSetMemObjectDestructorCallback;
    clCreateSampler_t *clCreateSampler;
    clCreateSamplerWithProperties_t *clCreateSamplerWithProperties;
    clRetainSampler_t *clRetainSampler;
    clReleaseSampler_t *clReleaseSampler;
    clGetSamplerInfo_t *clGetSamplerInfo;
    clCreateProgramWithSource_t *clCreateProgramWithSource;
    clCreateProgramWithBinary_t *clCreateProgramWithBinary;
    clCreateProgramWithBuiltInKernels_t *clCreateProgramWithBuiltInKernels;
    clRetainProgram_t *clRetainProgram;
    clReleaseProgram_t *clReleaseProgram;
    clBuildProgram_t *clBuildProgram;
    clCompileProgram_t *clCompileProgram;
    clLinkProgram_t *clLinkProgram;
    clUnloadCompiler_t *clUnloadCompiler;
    clUnloadPlatformCompiler_t *clUnloadPlatformCompiler;
    clGetProgramInfo_t *clGetProgramInfo;
    clGetProgramBuildInfo_t *clGetProgramBuildInfo;
    clCreateKernel_t *clCreateKernel;
    clCreateKernelsInProgram_t *clCreateKernelsInProgram;
    clRetainKernel_t *clRetainKernel;
    clReleaseKernel_t *clReleaseKernel;
    clSetKernelArg_t *clSetKernelArg;
    clGetKernelInfo_t *clGetKernelInfo;
    clGetKernelArgInfo_t *clGetKernelArgInfo;
    clGetKernelWorkGroupInfo_t *clGetKernelWorkGroupInfo;
    clWaitForEvents_t *clWaitForEvents;
    clGetEventInfo_t *clGetEventInfo;
    clCreateUserEvent_t *clCreateUserEvent;
    clRetainEvent_t *clRetainEvent;
    clReleaseEvent_t *clReleaseEvent;
    clSetUserEventStatus_t *clSetUserEventStatus;
    clSetEventCallback_t *clSetEventCallback;
    clGetEventProfilingInfo_t *clGetEventProfilingInfo;
    clFlush_t *clFlush;
    clFinish_t *clFinish;
    clEnqueueReadBuffer_t *clEnqueueReadBuffer;
    clEnqueueReadBufferRect_t *clEnqueueReadBufferRect;
    clEnqueueWriteBuffer_t *clEnqueueWriteBuffer;
    clEnqueueWriteBufferRect_t *clEnqueueWriteBufferRect;
    clEnqueueFillBuffer_t *clEnqueueFillBuffer;
    clEnqueueCopyBuffer_t *clEnqueueCopyBuffer;
    clEnqueueCopyBufferRect_t *clEnqueueCopyBufferRect;
    clEnqueueReadImage_t *clEnqueueReadImage;
    clEnqueueWriteImage_t *clEnqueueWriteImage;
    clEnqueueFillImage_t *clEnqueueFillImage;
    clEnqueueCopyImage_t *clEnqueueCopyImage;
    clEnqueueCopyImageToBuffer_t *clEnqueueCopyImageToBuffer;
    clEnqueueCopyBufferToImage_t *clEnqueueCopyBufferToImage;
    clEnqueueMapBuffer_t *clEnqueueMapBuffer;
    clEnqueueMapImage_t *clEnqueueMapImage;
    clEnqueueUnmapMemObject_t *clEnqueueUnmapMemObject;
    clEnqueueMigrateMemObjects_t *clEnqueueMigrateMemObjects;
    clEnqueueNDRangeKernel_t *clEnqueueNDRangeKernel;
    clEnqueueTask_t *clEnqueueTask;
    clEnqueueNativeKernel_t *clEnqueueNativeKernel;
    clEnqueueMarker_t *clEnqueueMarker;
    clEnqueueMarkerWithWaitList_t *clEnqueueMarkerWithWaitList;
    clEnqueueWaitForEvents_t *clEnqueueWaitForEvents;
    clEnqueueBarrier_t *clEnqueueBarrier;
    clEnqueueBarrierWithWaitList_t *clEnqueueBarrierWithWaitList;
    clGetExtensionFunctionAddress_t *clGetExtensionFunctionAddress;
    clGetExtensionFunctionAddressForPlatform_t *clGetExtensionFunctionAddressForPlatform;
    clCreatePipe_t *clCreatePipe;
    clGetPipeInfo_t *clGetPipeInfo;
    clSVMAlloc_t *clSVMAlloc;
    clSVMFree_t *clSVMFree;
    clEnqueueSVMFree_t *clEnqueueSVMFree;
    clEnqueueSVMMemcpy_t *clEnqueueSVMMemcpy;
    clEnqueueSVMMemFill_t *clEnqueueSVMMemFill;
    clEnqueueSVMMap_t *clEnqueueSVMMap;
    clEnqueueSVMUnmap_t *clEnqueueSVMUnmap;
    clSetKernelArgSVMPointer_t *clSetKernelArgSVMPointer;
    clSetKernelExecInfo_t *clSetKernelExecInfo;
    clGetKernelSubGroupInfoKHR_t *clGetKernelSubGroupInfoKHR;
    cl_int (CL_API_CALL *clSetPerfHintQCOM)(cl_context, cl_uint);
} g_real;

static void init_adreno_cl(void) {
    g_adreno_cl = hybris_dlopen("/vendor/lib64/libOpenCL.so", RTLD_NOW);
    if (!g_adreno_cl) return;
#define LOAD_SYM(name) g_real.name = (__typeof__(g_real.name))hybris_dlsym(g_adreno_cl, #name)
    LOAD_SYM(clGetPlatformIDs);
    LOAD_SYM(clGetPlatformInfo);
    LOAD_SYM(clGetDeviceIDs);
    LOAD_SYM(clGetDeviceInfo);
    LOAD_SYM(clCreateSubDevices);
    LOAD_SYM(clRetainDevice);
    LOAD_SYM(clReleaseDevice);
    LOAD_SYM(clCreateContext);
    LOAD_SYM(clCreateContextFromType);
    LOAD_SYM(clRetainContext);
    LOAD_SYM(clReleaseContext);
    LOAD_SYM(clGetContextInfo);
    LOAD_SYM(clCreateCommandQueue);
    LOAD_SYM(clCreateCommandQueueWithProperties);
    LOAD_SYM(clRetainCommandQueue);
    LOAD_SYM(clReleaseCommandQueue);
    LOAD_SYM(clGetCommandQueueInfo);
    LOAD_SYM(clSetCommandQueueProperty);
    LOAD_SYM(clCreateBuffer);
    LOAD_SYM(clCreateSubBuffer);
    LOAD_SYM(clCreateImage);
    LOAD_SYM(clCreateImage2D);
    LOAD_SYM(clCreateImage3D);
    LOAD_SYM(clRetainMemObject);
    LOAD_SYM(clReleaseMemObject);
    LOAD_SYM(clGetSupportedImageFormats);
    LOAD_SYM(clGetMemObjectInfo);
    LOAD_SYM(clGetImageInfo);
    LOAD_SYM(clSetMemObjectDestructorCallback);
    LOAD_SYM(clCreateSampler);
    LOAD_SYM(clCreateSamplerWithProperties);
    LOAD_SYM(clRetainSampler);
    LOAD_SYM(clReleaseSampler);
    LOAD_SYM(clGetSamplerInfo);
    LOAD_SYM(clCreateProgramWithSource);
    LOAD_SYM(clCreateProgramWithBinary);
    LOAD_SYM(clCreateProgramWithBuiltInKernels);
    LOAD_SYM(clRetainProgram);
    LOAD_SYM(clReleaseProgram);
    LOAD_SYM(clBuildProgram);
    LOAD_SYM(clCompileProgram);
    LOAD_SYM(clLinkProgram);
    LOAD_SYM(clUnloadCompiler);
    LOAD_SYM(clUnloadPlatformCompiler);
    LOAD_SYM(clGetProgramInfo);
    LOAD_SYM(clGetProgramBuildInfo);
    LOAD_SYM(clCreateKernel);
    LOAD_SYM(clCreateKernelsInProgram);
    LOAD_SYM(clRetainKernel);
    LOAD_SYM(clReleaseKernel);
    LOAD_SYM(clSetKernelArg);
    LOAD_SYM(clGetKernelInfo);
    LOAD_SYM(clGetKernelArgInfo);
    LOAD_SYM(clGetKernelWorkGroupInfo);
    LOAD_SYM(clWaitForEvents);
    LOAD_SYM(clGetEventInfo);
    LOAD_SYM(clCreateUserEvent);
    LOAD_SYM(clRetainEvent);
    LOAD_SYM(clReleaseEvent);
    LOAD_SYM(clSetUserEventStatus);
    LOAD_SYM(clSetEventCallback);
    LOAD_SYM(clGetEventProfilingInfo);
    LOAD_SYM(clFlush);
    LOAD_SYM(clFinish);
    LOAD_SYM(clEnqueueReadBuffer);
    LOAD_SYM(clEnqueueReadBufferRect);
    LOAD_SYM(clEnqueueWriteBuffer);
    LOAD_SYM(clEnqueueWriteBufferRect);
    LOAD_SYM(clEnqueueFillBuffer);
    LOAD_SYM(clEnqueueCopyBuffer);
    LOAD_SYM(clEnqueueCopyBufferRect);
    LOAD_SYM(clEnqueueReadImage);
    LOAD_SYM(clEnqueueWriteImage);
    LOAD_SYM(clEnqueueFillImage);
    LOAD_SYM(clEnqueueCopyImage);
    LOAD_SYM(clEnqueueCopyImageToBuffer);
    LOAD_SYM(clEnqueueCopyBufferToImage);
    LOAD_SYM(clEnqueueMapBuffer);
    LOAD_SYM(clEnqueueMapImage);
    LOAD_SYM(clEnqueueUnmapMemObject);
    LOAD_SYM(clEnqueueMigrateMemObjects);
    LOAD_SYM(clEnqueueNDRangeKernel);
    LOAD_SYM(clEnqueueTask);
    LOAD_SYM(clEnqueueNativeKernel);
    LOAD_SYM(clEnqueueMarker);
    LOAD_SYM(clEnqueueMarkerWithWaitList);
    LOAD_SYM(clEnqueueWaitForEvents);
    LOAD_SYM(clEnqueueBarrier);
    LOAD_SYM(clEnqueueBarrierWithWaitList);
    LOAD_SYM(clGetExtensionFunctionAddress);
    LOAD_SYM(clGetExtensionFunctionAddressForPlatform);
    LOAD_SYM(clCreatePipe);
    LOAD_SYM(clGetPipeInfo);
    LOAD_SYM(clSVMAlloc);
    LOAD_SYM(clSVMFree);
    LOAD_SYM(clEnqueueSVMFree);
    LOAD_SYM(clEnqueueSVMMemcpy);
    LOAD_SYM(clEnqueueSVMMemFill);
    LOAD_SYM(clEnqueueSVMMap);
    LOAD_SYM(clEnqueueSVMUnmap);
    LOAD_SYM(clSetKernelArgSVMPointer);
    LOAD_SYM(clSetKernelExecInfo);
    LOAD_SYM(clGetKernelSubGroupInfoKHR);
    LOAD_SYM(clSetPerfHintQCOM);
#undef LOAD_SYM
}

static inline void ensure_init(void) {
    if (__atomic_load_n(&g_inited, __ATOMIC_ACQUIRE)) return;
    pthread_mutex_lock(&g_init_mu);
    if (!g_inited) {
        init_adreno_cl();
        __atomic_store_n(&g_inited, 1, __ATOMIC_RELEASE);
    }
    pthread_mutex_unlock(&g_init_mu);
}

static inline size_t hash_real(hy_obj_kind_t kind, const void *real) {
    uintptr_t v = (uintptr_t)real ^ ((uintptr_t)kind * 0x9e3779b97f4a7c15ULL);
    v ^= v >> 30;
    v *= 0xbf58476d1ce4e5b9ULL;
    v ^= v >> 27;
    return (size_t)(v % MAP_BUCKETS);
}

static inline size_t hash_ptr(const void *ptr) {
    uintptr_t v = (uintptr_t)ptr;
    v ^= v >> 30;
    v *= 0xbf58476d1ce4e5b9ULL;
    v ^= v >> 27;
    return (size_t)(v % MAP_BUCKETS);
}

static void *hy_wrap(hy_obj_kind_t kind, void *real, int add_ref) {
    if (!real) return NULL;
    pthread_mutex_lock(&g_map_mu);
    size_t rb = hash_real(kind, real);
    hy_cl_obj *cur = g_real_buckets[rb];
    while (cur) {
        if (cur->kind == kind && cur->real == real) {
            if (add_ref && kind != HY_OBJ_PLATFORM && kind != HY_OBJ_DEVICE) {
                cur->refcnt++;
            }
            pthread_mutex_unlock(&g_map_mu);
            return cur;
        }
        cur = cur->next_real;
    }
    hy_cl_obj *obj = (hy_cl_obj *)calloc(1, sizeof(hy_cl_obj));
    if (!obj) {
        pthread_mutex_unlock(&g_map_mu);
        return NULL;
    }
    obj->dispatch = &g_icd_dispatch;
    obj->real = real;
    obj->magic = HY_MAGIC;
    obj->kind = kind;
    obj->refcnt = 1;
    obj->next_real = g_real_buckets[rb];
    g_real_buckets[rb] = obj;

    size_t pb = hash_ptr(obj);
    obj->next_ptr = g_ptr_buckets[pb];
    g_ptr_buckets[pb] = obj;
    pthread_mutex_unlock(&g_map_mu);
    return obj;
}

static inline void *hy_unwrap(const void *p) {
    if (!p) return NULL;
    const hy_cl_obj *obj = (const hy_cl_obj *)p;
    if (obj->magic == HY_MAGIC) return obj->real;
    return (void *)p;
}

static void *hy_try_unwrap_kernel_arg_ptr(const void *cand) {
    if (!cand) return NULL;
    pthread_mutex_lock(&g_map_mu);
    size_t pb = hash_ptr(cand);
    hy_cl_obj *cur = g_ptr_buckets[pb];
    while (cur) {
        if (cur == cand && (cur->kind == HY_OBJ_MEM || cur->kind == HY_OBJ_SAMPLER || cur->kind == HY_OBJ_QUEUE)) {
            void *r = cur->real;
            pthread_mutex_unlock(&g_map_mu);
            return r;
        }
        cur = cur->next_ptr;
    }
    pthread_mutex_unlock(&g_map_mu);
    return NULL;
}

static void hy_retain_obj(void *p) {
    if (!p) return;
    hy_cl_obj *obj = (hy_cl_obj *)p;
    if (obj->magic != HY_MAGIC || obj->kind == HY_OBJ_PLATFORM || obj->kind == HY_OBJ_DEVICE) return;
    pthread_mutex_lock(&g_map_mu);
    obj->refcnt++;
    pthread_mutex_unlock(&g_map_mu);
}

static void hy_unlink_free_obj(void *p) {
    if (!p) return;
    hy_cl_obj *obj = (hy_cl_obj *)p;
    if (obj->magic != HY_MAGIC) return;
    pthread_mutex_lock(&g_map_mu);
    size_t rb = hash_real(obj->kind, obj->real);
    hy_cl_obj **pr = &g_real_buckets[rb];
    while (*pr) {
        if (*pr == obj) { *pr = obj->next_real; break; }
        pr = &(*pr)->next_real;
    }
    size_t pb = hash_ptr(obj);
    hy_cl_obj **pp = &g_ptr_buckets[pb];
    while (*pp) {
        if (*pp == obj) { *pp = obj->next_ptr; break; }
        pp = &(*pp)->next_ptr;
    }
    pthread_mutex_unlock(&g_map_mu);
    free(obj);
}

static hy_cl_obj *hy_release_prepare(void *p, int *should_free) {
    *should_free = 0;
    if (!p) return NULL;
    hy_cl_obj *obj = (hy_cl_obj *)p;
    if (obj->magic != HY_MAGIC || obj->kind == HY_OBJ_PLATFORM || obj->kind == HY_OBJ_DEVICE) return NULL;
    pthread_mutex_lock(&g_map_mu);
    obj->refcnt--;
    if (obj->refcnt <= 0) {
        size_t rb = hash_real(obj->kind, obj->real);
        hy_cl_obj **pr = &g_real_buckets[rb];
        while (*pr) {
            if (*pr == obj) { *pr = obj->next_real; break; }
            pr = &(*pr)->next_real;
        }
        size_t pb = hash_ptr(obj);
        hy_cl_obj **pp = &g_ptr_buckets[pb];
        while (*pp) {
            if (*pp == obj) { *pp = obj->next_ptr; break; }
            pp = &(*pp)->next_ptr;
        }
        *should_free = 1;
    }
    pthread_mutex_unlock(&g_map_mu);
    return obj;
}

static cl_int hy_ret_str(const char *s, size_t param_value_size, void *param_value, size_t *param_value_size_ret) {
    size_t len = strlen(s) + 1;
    if (param_value_size_ret) *param_value_size_ret = len;
    if (param_value) {
        if (param_value_size < len) return CL_INVALID_VALUE;
        memcpy(param_value, s, len);
    }
    return CL_SUCCESS;
}

static const void *const *unwrap_list_16(cl_uint n, const void *const *in, void **stack_buf, void ***heap_buf) {
    *heap_buf = NULL;
    if (!in || n == 0) return NULL;
    void **dst = stack_buf;
    if (n > 16) {
        dst = (void **)malloc((size_t)n * sizeof(void *));
        if (!dst) return NULL;
        *heap_buf = dst;
    }
    for (cl_uint i = 0; i < n; i++) dst[i] = hy_unwrap(in[i]);
    return (const void *const *)dst;
}

static const cl_context_properties *unwrap_ctx_props(const cl_context_properties *props, cl_context_properties *stack_buf, cl_context_properties **heap_buf) {
    *heap_buf = NULL;
    if (!props) return NULL;
    size_t cnt = 0;
    while (props[cnt] != 0 && cnt < 126) cnt += 2;
    cnt += 1;
    cl_context_properties *dst = stack_buf;
    if (cnt > 32) {
        dst = (cl_context_properties *)malloc(cnt * sizeof(cl_context_properties));
        if (!dst) return props;
        *heap_buf = dst;
    }
    for (size_t i = 0; i < cnt - 1; i += 2) {
        dst[i] = props[i];
        if (props[i] == CL_CONTEXT_PLATFORM) {
            dst[i + 1] = (cl_context_properties)(uintptr_t)hy_unwrap((const void *)(uintptr_t)props[i + 1]);
        } else {
            dst[i + 1] = props[i + 1];
        }
    }
    dst[cnt - 1] = 0;
    return dst;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clGetPlatformIDs(cl_uint num_entries, cl_platform_id *platforms, cl_uint *num_platforms) {
    ensure_init();
    if (!g_real.clGetPlatformIDs) {
        if (num_platforms) *num_platforms = 0;
        return CL_PLATFORM_NOT_FOUND_KHR;
    }
    if (!platforms && !num_platforms) return CL_INVALID_VALUE;
    if (platforms && num_entries == 0) return CL_INVALID_VALUE;
    cl_platform_id raw[8] = {0};
    cl_uint cap = (platforms && num_entries > 0) ? (num_entries < 8 ? num_entries : 8) : 0;
    cl_uint real_n = 0;
    cl_int err = g_real.clGetPlatformIDs(cap ? cap : (platforms ? num_entries : 0), platforms ? raw : NULL, &real_n);
    if (num_platforms) *num_platforms = real_n;
    if (err == CL_SUCCESS && platforms && cap > 0) {
        cl_uint cnt = real_n < cap ? real_n : cap;
        for (cl_uint i = 0; i < cnt; i++) {
            platforms[i] = raw[i] ? (cl_platform_id)hy_wrap(HY_OBJ_PLATFORM, raw[i], 0) : NULL;
        }
    }
    return err;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clIcdGetPlatformIDsKHR(cl_uint num_entries, cl_platform_id *platforms, cl_uint *num_platforms) {
    return hy_clGetPlatformIDs(num_entries, platforms, num_platforms);
}

CL_API_ENTRY cl_int CL_API_CALL hy_clGetPlatformInfo(cl_platform_id platform, cl_platform_info param_name, size_t param_value_size, void *param_value, size_t *param_value_size_ret) {
    ensure_init();
    if (!g_real.clGetPlatformInfo) return CL_INVALID_PLATFORM;
    void *rp = hy_unwrap(platform);
    if (param_name == CL_PLATFORM_ICD_SUFFIX_KHR) {
        return hy_ret_str("QCOM", param_value_size, param_value, param_value_size_ret);
    }
    if (param_name == CL_PLATFORM_PROFILE) {
        cl_int r = g_real.clGetPlatformInfo((cl_platform_id)rp, param_name, param_value_size, param_value, param_value_size_ret);
        if (r == CL_SUCCESS) return r;
        return hy_ret_str("FULL_PROFILE", param_value_size, param_value, param_value_size_ret);
    }
    if (param_name == CL_PLATFORM_EXTENSIONS) {
        char buf[1024];
        size_t sz = 0;
        cl_int r = g_real.clGetPlatformInfo((cl_platform_id)rp, param_name, sizeof(buf) - 64, buf, &sz);
        if (r != CL_SUCCESS || sz <= 1) {
            return hy_ret_str("cl_khr_icd cl_khr_fp16", param_value_size, param_value, param_value_size_ret);
        }
        buf[sizeof(buf) - 65] = '\0';
        if (!strstr(buf, "cl_khr_icd")) strcat(buf, " cl_khr_icd");
        return hy_ret_str(buf, param_value_size, param_value, param_value_size_ret);
    }
    if (param_name == CL_PLATFORM_VENDOR) {
        char buf[256];
        size_t sz = 0;
        cl_int r = g_real.clGetPlatformInfo((cl_platform_id)rp, param_name, sizeof(buf), buf, &sz);
        if (r == CL_SUCCESS && buf[0] != '\0' && !(buf[0] == ' ' && buf[1] == '\0')) {
            return hy_ret_str(buf, param_value_size, param_value, param_value_size_ret);
        }
        return hy_ret_str("QUALCOMM", param_value_size, param_value, param_value_size_ret);
    }
    return g_real.clGetPlatformInfo((cl_platform_id)rp, param_name, param_value_size, param_value, param_value_size_ret);
}

CL_API_ENTRY cl_int CL_API_CALL hy_clGetDeviceIDs(cl_platform_id platform, cl_device_type device_type, cl_uint num_entries, cl_device_id *devices, cl_uint *num_devices) {
    ensure_init();
    if (!g_real.clGetDeviceIDs) return CL_DEVICE_NOT_FOUND;
    cl_device_id raw[16] = {0};
    cl_device_id *heap = NULL;
    cl_device_id *dst = raw;
    if (devices && num_entries > 16) {
        heap = (cl_device_id *)calloc((size_t)num_entries, sizeof(cl_device_id));
        if (!heap) return CL_OUT_OF_HOST_MEMORY;
        dst = heap;
    }
    cl_uint real_n = 0;
    cl_int err = g_real.clGetDeviceIDs((cl_platform_id)hy_unwrap(platform), device_type, num_entries, devices ? dst : NULL, &real_n);
    if (num_devices) *num_devices = real_n;
    if (err == CL_SUCCESS && devices && num_entries > 0) {
        cl_uint cnt = real_n < num_entries ? real_n : num_entries;
        for (cl_uint i = 0; i < cnt; i++) {
            devices[i] = dst[i] ? (cl_device_id)hy_wrap(HY_OBJ_DEVICE, dst[i], 0) : NULL;
        }
    }
    free(heap);
    return err;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clGetDeviceInfo(cl_device_id device, cl_device_info param_name, size_t param_value_size, void *param_value, size_t *param_value_size_ret) {
    ensure_init();
    if (!g_real.clGetDeviceInfo) return CL_INVALID_DEVICE;
    cl_device_id rd = (cl_device_id)hy_unwrap(device);
    if (param_name == CL_DEVICE_PLATFORM) {
        cl_platform_id rp = NULL;
        cl_int r = g_real.clGetDeviceInfo(rd, param_name, sizeof(rp), &rp, NULL);
        if (r != CL_SUCCESS) return r;
        if (param_value_size_ret) *param_value_size_ret = sizeof(cl_platform_id);
        if (param_value) {
            if (param_value_size < sizeof(cl_platform_id)) return CL_INVALID_VALUE;
            *(cl_platform_id *)param_value = (cl_platform_id)hy_wrap(HY_OBJ_PLATFORM, rp, 0);
        }
        return CL_SUCCESS;
    }
    if (param_name == CL_DEVICE_PARENT_DEVICE) {
        cl_device_id rpd = NULL;
        cl_int r = g_real.clGetDeviceInfo(rd, param_name, sizeof(rpd), &rpd, NULL);
        if (r != CL_SUCCESS) return r;
        if (param_value_size_ret) *param_value_size_ret = sizeof(cl_device_id);
        if (param_value) {
            if (param_value_size < sizeof(cl_device_id)) return CL_INVALID_VALUE;
            *(cl_device_id *)param_value = (cl_device_id)(rpd ? hy_wrap(HY_OBJ_DEVICE, rpd, 0) : NULL);
        }
        return CL_SUCCESS;
    }
    if (param_name == CL_DEVICE_OPENCL_C_VERSION) {
        char buf[128];
        size_t sz = 0;
        cl_int r = g_real.clGetDeviceInfo(rd, param_name, sizeof(buf), buf, &sz);
        if (r == CL_SUCCESS && buf[0] != '\0' && !(buf[0] == ' ' && buf[1] == '\0')) {
            return hy_ret_str(buf, param_value_size, param_value, param_value_size_ret);
        }
        return hy_ret_str("OpenCL C 2.0 Adreno(TM) 540", param_value_size, param_value, param_value_size_ret);
    }
    return g_real.clGetDeviceInfo(rd, param_name, param_value_size, param_value, param_value_size_ret);
}

CL_API_ENTRY cl_int CL_API_CALL hy_clCreateSubDevices(cl_device_id in_device, const cl_device_partition_property *properties, cl_uint num_devices, cl_device_id *out_devices, cl_uint *num_devices_ret) {
    ensure_init();
    if (!g_real.clCreateSubDevices) return CL_INVALID_OPERATION;
    if (out_devices && num_devices == 0) return CL_INVALID_VALUE;
    cl_device_id raw[16] = {0};
    cl_device_id *heap = NULL;
    cl_device_id *dst = raw;
    if (out_devices && num_devices > 16) {
        heap = (cl_device_id *)calloc((size_t)num_devices, sizeof(cl_device_id));
        if (!heap) return CL_OUT_OF_HOST_MEMORY;
        dst = heap;
    }
    cl_uint real_n = 0;
    cl_uint *p_ret = (out_devices || num_devices_ret) ? &real_n : NULL;
    cl_int err = g_real.clCreateSubDevices((cl_device_id)hy_unwrap(in_device), properties, num_devices, out_devices ? dst : NULL, p_ret);
    if (err == CL_SUCCESS && out_devices && num_devices > 0) {
        cl_uint cnt = real_n < num_devices ? real_n : num_devices;
        for (cl_uint i = 0; i < cnt; i++) {
            if (dst[i]) {
                out_devices[i] = (cl_device_id)hy_wrap(HY_OBJ_DEVICE, dst[i], 0);
                if (!out_devices[i]) {
                    for (cl_uint j = 0; j < i; j++) {
                        hy_unlink_free_obj(out_devices[j]);
                        out_devices[j] = NULL;
                    }
                    if (g_real.clReleaseDevice) {
                        for (cl_uint j = 0; j < cnt; j++) {
                            if (dst[j]) g_real.clReleaseDevice(dst[j]);
                        }
                    }
                    err = CL_OUT_OF_HOST_MEMORY;
                    break;
                }
            } else {
                out_devices[i] = NULL;
            }
        }
    }
    if (err == CL_SUCCESS && num_devices_ret && p_ret) *num_devices_ret = real_n;
    free(heap);
    return err;
}
CL_API_ENTRY cl_int CL_API_CALL hy_clRetainDevice(cl_device_id device) {
    ensure_init();
    return g_real.clRetainDevice ? g_real.clRetainDevice((cl_device_id)hy_unwrap(device)) : CL_SUCCESS;
}
CL_API_ENTRY cl_int CL_API_CALL hy_clReleaseDevice(cl_device_id device) {
    ensure_init();
    return g_real.clReleaseDevice ? g_real.clReleaseDevice((cl_device_id)hy_unwrap(device)) : CL_SUCCESS;
}

CL_API_ENTRY cl_context CL_API_CALL hy_clCreateContext(const cl_context_properties *properties, cl_uint num_devices, const cl_device_id *devices, void (CL_CALLBACK *pfn_notify)(const char *, const void *, size_t, void *), void *user_data, cl_int *errcode_ret) {
    ensure_init();
    if (!g_real.clCreateContext) { if (errcode_ret) *errcode_ret = CL_INVALID_OPERATION; return NULL; }
    cl_context_properties sprops[32], *hprops = NULL;
    const cl_context_properties *rp = unwrap_ctx_props(properties, sprops, &hprops);
    void *sdevs[16], **hdevs = NULL;
    const cl_device_id *rdevs = (const cl_device_id *)unwrap_list_16(num_devices, (const void *const *)devices, sdevs, &hdevs);
    cl_context rc = g_real.clCreateContext(rp, num_devices, rdevs, pfn_notify, user_data, errcode_ret);
    free(hdevs);
    free(hprops);
    return (cl_context)hy_wrap(HY_OBJ_CONTEXT, rc, 1);
}

CL_API_ENTRY cl_context CL_API_CALL hy_clCreateContextFromType(const cl_context_properties *properties, cl_device_type device_type, void (CL_CALLBACK *pfn_notify)(const char *, const void *, size_t, void *), void *user_data, cl_int *errcode_ret) {
    ensure_init();
    if (!g_real.clCreateContextFromType) { if (errcode_ret) *errcode_ret = CL_INVALID_OPERATION; return NULL; }
    cl_context_properties sprops[32], *hprops = NULL;
    const cl_context_properties *rp = unwrap_ctx_props(properties, sprops, &hprops);
    cl_context rc = g_real.clCreateContextFromType(rp, device_type, pfn_notify, user_data, errcode_ret);
    free(hprops);
    return (cl_context)hy_wrap(HY_OBJ_CONTEXT, rc, 1);
}

CL_API_ENTRY cl_int CL_API_CALL hy_clRetainContext(cl_context context) {
    ensure_init();
    cl_int r = g_real.clRetainContext((cl_context)hy_unwrap(context));
    if (r == CL_SUCCESS) hy_retain_obj(context);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clReleaseContext(cl_context context) {
    ensure_init();
    int sf = 0;
    void *raw = hy_unwrap(context);
    hy_cl_obj *obj = hy_release_prepare(context, &sf);
    cl_int r = g_real.clReleaseContext((cl_context)raw);
    if (sf) free(obj);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clGetContextInfo(cl_context context, cl_context_info param_name, size_t param_value_size, void *param_value, size_t *param_value_size_ret) {
    ensure_init();
    cl_context rc = (cl_context)hy_unwrap(context);
    if (param_name == CL_CONTEXT_DEVICES && param_value && param_value_size >= sizeof(cl_device_id)) {
        size_t sz = 0;
        cl_device_id raw[16];
        size_t qsz = param_value_size <= sizeof(raw) ? param_value_size : sizeof(raw);
        cl_int r = g_real.clGetContextInfo(rc, param_name, qsz, raw, &sz);
        if (param_value_size_ret) *param_value_size_ret = sz;
        if (r == CL_SUCCESS) {
            size_t n = sz / sizeof(cl_device_id);
            cl_device_id *out = (cl_device_id *)param_value;
            for (size_t i = 0; i < n; i++) out[i] = (cl_device_id)hy_wrap(HY_OBJ_DEVICE, raw[i], 0);
        }
        return r;
    }
    return g_real.clGetContextInfo(rc, param_name, param_value_size, param_value, param_value_size_ret);
}

CL_API_ENTRY cl_command_queue CL_API_CALL hy_clCreateCommandQueue(cl_context context, cl_device_id device, cl_command_queue_properties properties, cl_int *errcode_ret) {
    ensure_init();
    cl_command_queue rq = g_real.clCreateCommandQueue((cl_context)hy_unwrap(context), (cl_device_id)hy_unwrap(device), properties, errcode_ret);
    return (cl_command_queue)hy_wrap(HY_OBJ_QUEUE, rq, 1);
}

CL_API_ENTRY cl_command_queue CL_API_CALL hy_clCreateCommandQueueWithProperties(cl_context context, cl_device_id device, const cl_queue_properties *properties, cl_int *errcode_ret) {
    ensure_init();
    if (!g_real.clCreateCommandQueueWithProperties) {
        cl_command_queue_properties props = 0;
        if (properties) {
            for (size_t i = 0; properties[i] != 0; i += 2) {
                if (properties[i] == CL_QUEUE_PROPERTIES) props = (cl_command_queue_properties)properties[i + 1];
            }
        }
        return hy_clCreateCommandQueue(context, device, props, errcode_ret);
    }
    cl_command_queue rq = g_real.clCreateCommandQueueWithProperties((cl_context)hy_unwrap(context), (cl_device_id)hy_unwrap(device), properties, errcode_ret);
    return (cl_command_queue)hy_wrap(HY_OBJ_QUEUE, rq, 1);
}

CL_API_ENTRY cl_int CL_API_CALL hy_clRetainCommandQueue(cl_command_queue cq) {
    ensure_init();
    cl_int r = g_real.clRetainCommandQueue((cl_command_queue)hy_unwrap(cq));
    if (r == CL_SUCCESS) hy_retain_obj(cq);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clReleaseCommandQueue(cl_command_queue cq) {
    ensure_init();
    int sf = 0;
    void *raw = hy_unwrap(cq);
    hy_cl_obj *obj = hy_release_prepare(cq, &sf);
    cl_int r = g_real.clReleaseCommandQueue((cl_command_queue)raw);
    if (sf) free(obj);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clGetCommandQueueInfo(cl_command_queue cq, cl_command_queue_info param_name, size_t param_value_size, void *param_value, size_t *param_value_size_ret) {
    ensure_init();
    cl_command_queue rq = (cl_command_queue)hy_unwrap(cq);
    if (param_name == CL_QUEUE_CONTEXT || param_name == CL_QUEUE_DEVICE || param_name == CL_QUEUE_DEVICE_DEFAULT) {
        void *rp = NULL;
        cl_int r = g_real.clGetCommandQueueInfo(rq, param_name, sizeof(rp), &rp, NULL);
        if (r != CL_SUCCESS) return r;
        if (param_value_size_ret) *param_value_size_ret = sizeof(void *);
        if (param_value) {
            if (param_value_size < sizeof(void *)) return CL_INVALID_VALUE;
            hy_obj_kind_t k = (param_name == CL_QUEUE_CONTEXT) ? HY_OBJ_CONTEXT : (param_name == CL_QUEUE_DEVICE ? HY_OBJ_DEVICE : HY_OBJ_QUEUE);
            *(void **)param_value = hy_wrap(k, rp, 0);
        }
        return CL_SUCCESS;
    }
    return g_real.clGetCommandQueueInfo(rq, param_name, param_value_size, param_value, param_value_size_ret);
}

CL_API_ENTRY cl_int CL_API_CALL hy_clSetCommandQueueProperty(cl_command_queue cq, cl_command_queue_properties properties, cl_bool enable, cl_command_queue_properties *old_properties) {
    ensure_init();
    if (!g_real.clSetCommandQueueProperty) return CL_INVALID_OPERATION;
    return g_real.clSetCommandQueueProperty((cl_command_queue)hy_unwrap(cq), properties, enable, old_properties);
}

CL_API_ENTRY cl_mem CL_API_CALL hy_clCreateBuffer(cl_context context, cl_mem_flags flags, size_t size, void *host_ptr, cl_int *errcode_ret) {
    ensure_init();
    cl_mem rm = g_real.clCreateBuffer((cl_context)hy_unwrap(context), flags, size, host_ptr, errcode_ret);
    return (cl_mem)hy_wrap(HY_OBJ_MEM, rm, 1);
}

CL_API_ENTRY cl_mem CL_API_CALL hy_clCreateSubBuffer(cl_mem buffer, cl_mem_flags flags, cl_buffer_create_type type, const void *info, cl_int *errcode_ret) {
    ensure_init();
    cl_mem rm = g_real.clCreateSubBuffer((cl_mem)hy_unwrap(buffer), flags, type, info, errcode_ret);
    return (cl_mem)hy_wrap(HY_OBJ_MEM, rm, 1);
}

CL_API_ENTRY cl_mem CL_API_CALL hy_clCreateImage(cl_context context, cl_mem_flags flags, const cl_image_format *image_format, const cl_image_desc *image_desc, void *host_ptr, cl_int *errcode_ret) {
    ensure_init();
    cl_image_desc desc;
    const cl_image_desc *pd = image_desc;
    if (image_desc && image_desc->mem_object) {
        desc = *image_desc;
        desc.mem_object = (cl_mem)hy_unwrap(image_desc->mem_object);
        pd = &desc;
    }
    cl_mem rm = g_real.clCreateImage((cl_context)hy_unwrap(context), flags, image_format, pd, host_ptr, errcode_ret);
    return (cl_mem)hy_wrap(HY_OBJ_MEM, rm, 1);
}

CL_API_ENTRY cl_mem CL_API_CALL hy_clCreateImage2D(cl_context context, cl_mem_flags flags, const cl_image_format *fmt, size_t w, size_t h, size_t row_pitch, void *host_ptr, cl_int *errcode_ret) {
    ensure_init();
    cl_mem rm = g_real.clCreateImage2D((cl_context)hy_unwrap(context), flags, fmt, w, h, row_pitch, host_ptr, errcode_ret);
    return (cl_mem)hy_wrap(HY_OBJ_MEM, rm, 1);
}

CL_API_ENTRY cl_mem CL_API_CALL hy_clCreateImage3D(cl_context context, cl_mem_flags flags, const cl_image_format *fmt, size_t w, size_t h, size_t d, size_t rp, size_t sp, void *host_ptr, cl_int *errcode_ret) {
    ensure_init();
    cl_mem rm = g_real.clCreateImage3D((cl_context)hy_unwrap(context), flags, fmt, w, h, d, rp, sp, host_ptr, errcode_ret);
    return (cl_mem)hy_wrap(HY_OBJ_MEM, rm, 1);
}

CL_API_ENTRY cl_int CL_API_CALL hy_clRetainMemObject(cl_mem memobj) {
    ensure_init();
    cl_int r = g_real.clRetainMemObject((cl_mem)hy_unwrap(memobj));
    if (r == CL_SUCCESS) hy_retain_obj(memobj);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clReleaseMemObject(cl_mem memobj) {
    ensure_init();
    int sf = 0;
    void *raw = hy_unwrap(memobj);
    hy_cl_obj *obj = hy_release_prepare(memobj, &sf);
    cl_int r = g_real.clReleaseMemObject((cl_mem)raw);
    if (sf) free(obj);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clGetSupportedImageFormats(cl_context context, cl_mem_flags flags, cl_mem_object_type type, cl_uint num_entries, cl_image_format *formats, cl_uint *num_image_formats) {
    ensure_init();
    return g_real.clGetSupportedImageFormats((cl_context)hy_unwrap(context), flags, type, num_entries, formats, num_image_formats);
}

CL_API_ENTRY cl_int CL_API_CALL hy_clGetMemObjectInfo(cl_mem memobj, cl_mem_info param_name, size_t param_value_size, void *param_value, size_t *param_value_size_ret) {
    ensure_init();
    cl_mem rm = (cl_mem)hy_unwrap(memobj);
    if (param_name == CL_MEM_CONTEXT || param_name == CL_MEM_ASSOCIATED_MEMOBJECT) {
        void *rp = NULL;
        cl_int r = g_real.clGetMemObjectInfo(rm, param_name, sizeof(rp), &rp, NULL);
        if (r != CL_SUCCESS) return r;
        if (param_value_size_ret) *param_value_size_ret = sizeof(void *);
        if (param_value) {
            if (param_value_size < sizeof(void *)) return CL_INVALID_VALUE;
            *(void **)param_value = rp ? hy_wrap(param_name == CL_MEM_CONTEXT ? HY_OBJ_CONTEXT : HY_OBJ_MEM, rp, 0) : NULL;
        }
        return CL_SUCCESS;
    }
    return g_real.clGetMemObjectInfo(rm, param_name, param_value_size, param_value, param_value_size_ret);
}

CL_API_ENTRY cl_int CL_API_CALL hy_clGetImageInfo(cl_mem image, cl_image_info param_name, size_t param_value_size, void *param_value, size_t *param_value_size_ret) {
    ensure_init();
    cl_mem rm = (cl_mem)hy_unwrap(image);
    if (param_name == CL_IMAGE_BUFFER) {
        void *rp = NULL;
        cl_int r = g_real.clGetImageInfo(rm, param_name, sizeof(rp), &rp, NULL);
        if (r != CL_SUCCESS) return r;
        if (param_value_size_ret) *param_value_size_ret = sizeof(void *);
        if (param_value) {
            if (param_value_size < sizeof(void *)) return CL_INVALID_VALUE;
            *(void **)param_value = rp ? hy_wrap(HY_OBJ_MEM, rp, 0) : NULL;
        }
        return CL_SUCCESS;
    }
    return g_real.clGetImageInfo(rm, param_name, param_value_size, param_value, param_value_size_ret);
}

typedef struct {
    void (CL_CALLBACK *pfn)(cl_mem, void *);
    void *user_data;
    cl_mem wrapped;
} mem_dtor_tramp_t;

static void CL_CALLBACK mem_dtor_cb(cl_mem raw_unused, void *ud) {
    (void)raw_unused;
    mem_dtor_tramp_t *t = (mem_dtor_tramp_t *)ud;
    if (!t) return;
    cl_mem wrapped = t->wrapped;
    void (CL_CALLBACK *pfn)(cl_mem, void *) = t->pfn;
    void *user_data = t->user_data;
    free(t);
    if (pfn) pfn(wrapped, user_data);
    int sf = 0;
    hy_cl_obj *obj = hy_release_prepare(wrapped, &sf);
    if (sf) free(obj);
}

CL_API_ENTRY cl_int CL_API_CALL hy_clSetMemObjectDestructorCallback(cl_mem memobj, void (CL_CALLBACK *pfn_notify)(cl_mem, void *), void *user_data) {
    ensure_init();
    if (!g_real.clSetMemObjectDestructorCallback) return CL_INVALID_OPERATION;
    if (!pfn_notify) return g_real.clSetMemObjectDestructorCallback((cl_mem)hy_unwrap(memobj), NULL, user_data);
    mem_dtor_tramp_t *t = (mem_dtor_tramp_t *)malloc(sizeof(mem_dtor_tramp_t));
    if (!t) return CL_OUT_OF_HOST_MEMORY;
    t->pfn = pfn_notify;
    t->user_data = user_data;
    t->wrapped = memobj;
    hy_retain_obj(memobj);
    cl_int r = g_real.clSetMemObjectDestructorCallback((cl_mem)hy_unwrap(memobj), mem_dtor_cb, t);
    if (r != CL_SUCCESS) {
        int sf = 0;
        hy_cl_obj *obj = hy_release_prepare(memobj, &sf);
        if (sf) free(obj);
        free(t);
    }
    return r;
}

CL_API_ENTRY cl_sampler CL_API_CALL hy_clCreateSampler(cl_context context, cl_bool normalized_coords, cl_addressing_mode addressing_mode, cl_filter_mode filter_mode, cl_int *errcode_ret) {
    ensure_init();
    cl_sampler rs = g_real.clCreateSampler((cl_context)hy_unwrap(context), normalized_coords, addressing_mode, filter_mode, errcode_ret);
    return (cl_sampler)hy_wrap(HY_OBJ_SAMPLER, rs, 1);
}

CL_API_ENTRY cl_sampler CL_API_CALL hy_clCreateSamplerWithProperties(cl_context context, const cl_sampler_properties *properties, cl_int *errcode_ret) {
    ensure_init();
    if (!g_real.clCreateSamplerWithProperties) {
        if (errcode_ret) *errcode_ret = CL_INVALID_OPERATION;
        return NULL;
    }
    cl_sampler rs = g_real.clCreateSamplerWithProperties((cl_context)hy_unwrap(context), properties, errcode_ret);
    return (cl_sampler)hy_wrap(HY_OBJ_SAMPLER, rs, 1);
}

CL_API_ENTRY cl_int CL_API_CALL hy_clRetainSampler(cl_sampler sampler) {
    ensure_init();
    cl_int r = g_real.clRetainSampler((cl_sampler)hy_unwrap(sampler));
    if (r == CL_SUCCESS) hy_retain_obj(sampler);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clReleaseSampler(cl_sampler sampler) {
    ensure_init();
    int sf = 0;
    void *raw = hy_unwrap(sampler);
    hy_cl_obj *obj = hy_release_prepare(sampler, &sf);
    cl_int r = g_real.clReleaseSampler((cl_sampler)raw);
    if (sf) free(obj);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clGetSamplerInfo(cl_sampler sampler, cl_sampler_info param_name, size_t param_value_size, void *param_value, size_t *param_value_size_ret) {
    ensure_init();
    cl_sampler rs = (cl_sampler)hy_unwrap(sampler);
    if (param_name == CL_SAMPLER_CONTEXT) {
        void *rp = NULL;
        cl_int r = g_real.clGetSamplerInfo(rs, param_name, sizeof(rp), &rp, NULL);
        if (r != CL_SUCCESS) return r;
        if (param_value_size_ret) *param_value_size_ret = sizeof(void *);
        if (param_value) {
            if (param_value_size < sizeof(void *)) return CL_INVALID_VALUE;
            *(void **)param_value = hy_wrap(HY_OBJ_CONTEXT, rp, 0);
        }
        return CL_SUCCESS;
    }
    return g_real.clGetSamplerInfo(rs, param_name, param_value_size, param_value, param_value_size_ret);
}

CL_API_ENTRY cl_program CL_API_CALL hy_clCreateProgramWithSource(cl_context context, cl_uint count, const char **strings, const size_t *lengths, cl_int *errcode_ret) {
    ensure_init();
    cl_program rp = g_real.clCreateProgramWithSource((cl_context)hy_unwrap(context), count, strings, lengths, errcode_ret);
    return (cl_program)hy_wrap(HY_OBJ_PROGRAM, rp, 1);
}

CL_API_ENTRY cl_program CL_API_CALL hy_clCreateProgramWithBinary(cl_context context, cl_uint num_devices, const cl_device_id *device_list, const size_t *lengths, const unsigned char **binaries, cl_int *binary_status, cl_int *errcode_ret) {
    ensure_init();
    void *sdevs[16], **hdevs = NULL;
    const cl_device_id *rdevs = (const cl_device_id *)unwrap_list_16(num_devices, (const void *const *)device_list, sdevs, &hdevs);
    cl_program rp = g_real.clCreateProgramWithBinary((cl_context)hy_unwrap(context), num_devices, rdevs, lengths, binaries, binary_status, errcode_ret);
    free(hdevs);
    return (cl_program)hy_wrap(HY_OBJ_PROGRAM, rp, 1);
}

CL_API_ENTRY cl_program CL_API_CALL hy_clCreateProgramWithBuiltInKernels(cl_context context, cl_uint num_devices, const cl_device_id *device_list, const char *kernel_names, cl_int *errcode_ret) {
    ensure_init();
    if (!g_real.clCreateProgramWithBuiltInKernels) { if (errcode_ret) *errcode_ret = CL_INVALID_OPERATION; return NULL; }
    void *sdevs[16], **hdevs = NULL;
    const cl_device_id *rdevs = (const cl_device_id *)unwrap_list_16(num_devices, (const void *const *)device_list, sdevs, &hdevs);
    cl_program rp = g_real.clCreateProgramWithBuiltInKernels((cl_context)hy_unwrap(context), num_devices, rdevs, kernel_names, errcode_ret);
    free(hdevs);
    return (cl_program)hy_wrap(HY_OBJ_PROGRAM, rp, 1);
}

CL_API_ENTRY cl_int CL_API_CALL hy_clRetainProgram(cl_program program) {
    ensure_init();
    cl_int r = g_real.clRetainProgram((cl_program)hy_unwrap(program));
    if (r == CL_SUCCESS) hy_retain_obj(program);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clReleaseProgram(cl_program program) {
    ensure_init();
    int sf = 0;
    void *raw = hy_unwrap(program);
    hy_cl_obj *obj = hy_release_prepare(program, &sf);
    cl_int r = g_real.clReleaseProgram((cl_program)raw);
    if (sf) free(obj);
    return r;
}

typedef struct {
    void (CL_CALLBACK *pfn)(cl_program, void *);
    void *user_data;
    cl_program wrapped;
    int refs;
    int fired;
} prog_cb_tramp_t;

static void prog_tramp_unref(prog_cb_tramp_t *t) {
    if (t && __atomic_sub_fetch(&t->refs, 1, __ATOMIC_ACQ_REL) == 0) {
        free(t);
    }
}

static void CL_CALLBACK prog_notify_cb(cl_program raw_p, void *ud) {
    (void)raw_p;
    prog_cb_tramp_t *t = (prog_cb_tramp_t *)ud;
    if (!t) return;
    if (!__atomic_exchange_n(&t->fired, 1, __ATOMIC_ACQ_REL)) {
        cl_program wrapped = t->wrapped;
        void (CL_CALLBACK *pfn)(cl_program, void *) = t->pfn;
        void *user_data = t->user_data;
        if (pfn) pfn(wrapped, user_data);
        int sf = 0;
        hy_cl_obj *obj = hy_release_prepare(wrapped, &sf);
        if (sf) free(obj);
    }
    prog_tramp_unref(t);
}

CL_API_ENTRY cl_int CL_API_CALL hy_clBuildProgram(cl_program program, cl_uint num_devices, const cl_device_id *device_list, const char *options, void (CL_CALLBACK *pfn_notify)(cl_program, void *), void *user_data) {
    ensure_init();
    void *sdevs[16], **hdevs = NULL;
    const cl_device_id *rdevs = (const cl_device_id *)unwrap_list_16(num_devices, (const void *const *)device_list, sdevs, &hdevs);
    prog_cb_tramp_t *t = NULL;
    if (pfn_notify) {
        t = (prog_cb_tramp_t *)malloc(sizeof(prog_cb_tramp_t));
        if (!t) { free(hdevs); return CL_OUT_OF_HOST_MEMORY; }
        t->pfn = pfn_notify;
        t->user_data = user_data;
        t->wrapped = program;
        t->refs = 2;
        t->fired = 0;
        hy_retain_obj(program);
    }
    cl_int r = g_real.clBuildProgram((cl_program)hy_unwrap(program), num_devices, rdevs, options, pfn_notify ? prog_notify_cb : NULL, pfn_notify ? t : user_data);
    if (t) {
        if (r != CL_SUCCESS && !__atomic_exchange_n(&t->fired, 1, __ATOMIC_ACQ_REL)) {
            int sf = 0;
            hy_cl_obj *obj = hy_release_prepare(program, &sf);
            if (sf) free(obj);
            prog_tramp_unref(t);
        }
        prog_tramp_unref(t);
    }
    free(hdevs);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clCompileProgram(cl_program program, cl_uint num_devices, const cl_device_id *device_list, const char *options, cl_uint num_input_headers, const cl_program *input_headers, const char **header_include_names, void (CL_CALLBACK *pfn_notify)(cl_program, void *), void *user_data) {
    ensure_init();
    if (!g_real.clCompileProgram) return CL_INVALID_OPERATION;
    void *sdevs[16], **hdevs = NULL, *shdrs[16], **hhdrs = NULL;
    const cl_device_id *rdevs = (const cl_device_id *)unwrap_list_16(num_devices, (const void *const *)device_list, sdevs, &hdevs);
    const cl_program *rhdrs = (const cl_program *)unwrap_list_16(num_input_headers, (const void *const *)input_headers, shdrs, &hhdrs);
    prog_cb_tramp_t *t = NULL;
    if (pfn_notify) {
        t = (prog_cb_tramp_t *)malloc(sizeof(prog_cb_tramp_t));
        if (!t) { free(hdevs); free(hhdrs); return CL_OUT_OF_HOST_MEMORY; }
        t->pfn = pfn_notify;
        t->user_data = user_data;
        t->wrapped = program;
        t->refs = 2;
        t->fired = 0;
        hy_retain_obj(program);
    }
    cl_int r = g_real.clCompileProgram((cl_program)hy_unwrap(program), num_devices, rdevs, options, num_input_headers, rhdrs, header_include_names, pfn_notify ? prog_notify_cb : NULL, pfn_notify ? t : user_data);
    if (t) {
        if (r != CL_SUCCESS && !__atomic_exchange_n(&t->fired, 1, __ATOMIC_ACQ_REL)) {
            int sf = 0;
            hy_cl_obj *obj = hy_release_prepare(program, &sf);
            if (sf) free(obj);
            prog_tramp_unref(t);
        }
        prog_tramp_unref(t);
    }
    free(hdevs);
    free(hhdrs);
    return r;
}

CL_API_ENTRY cl_program CL_API_CALL hy_clLinkProgram(cl_context context, cl_uint num_devices, const cl_device_id *device_list, const char *options, cl_uint num_input_programs, const cl_program *input_programs, void (CL_CALLBACK *pfn_notify)(cl_program, void *), void *user_data, cl_int *errcode_ret) {
    ensure_init();
    if (!g_real.clLinkProgram) { if (errcode_ret) *errcode_ret = CL_INVALID_OPERATION; return NULL; }
    void *sdevs[16], **hdevs = NULL, *sprogs[16], **hprogs = NULL;
    const cl_device_id *rdevs = (const cl_device_id *)unwrap_list_16(num_devices, (const void *const *)device_list, sdevs, &hdevs);
    const cl_program *rprogs = (const cl_program *)unwrap_list_16(num_input_programs, (const void *const *)input_programs, sprogs, &hprogs);
    cl_program rp = g_real.clLinkProgram((cl_context)hy_unwrap(context), num_devices, rdevs, options, num_input_programs, rprogs, NULL, NULL, errcode_ret);
    free(hdevs);
    free(hprogs);
    cl_program wp = (cl_program)hy_wrap(HY_OBJ_PROGRAM, rp, 1);
    if (pfn_notify && wp) pfn_notify(wp, user_data);
    return wp;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clUnloadCompiler(void) {
    ensure_init();
    return g_real.clUnloadCompiler ? g_real.clUnloadCompiler() : CL_SUCCESS;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clUnloadPlatformCompiler(cl_platform_id platform) {
    ensure_init();
    return g_real.clUnloadPlatformCompiler ? g_real.clUnloadPlatformCompiler((cl_platform_id)hy_unwrap(platform)) : CL_SUCCESS;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clGetProgramInfo(cl_program program, cl_program_info param_name, size_t param_value_size, void *param_value, size_t *param_value_size_ret) {
    ensure_init();
    cl_program rp = (cl_program)hy_unwrap(program);
    if (param_name == CL_PROGRAM_CONTEXT) {
        void *ctx = NULL;
        cl_int r = g_real.clGetProgramInfo(rp, param_name, sizeof(ctx), &ctx, NULL);
        if (r != CL_SUCCESS) return r;
        if (param_value_size_ret) *param_value_size_ret = sizeof(void *);
        if (param_value) {
            if (param_value_size < sizeof(void *)) return CL_INVALID_VALUE;
            *(void **)param_value = hy_wrap(HY_OBJ_CONTEXT, ctx, 0);
        }
        return CL_SUCCESS;
    }
    if (param_name == CL_PROGRAM_DEVICES && param_value && param_value_size >= sizeof(cl_device_id)) {
        size_t sz = 0;
        cl_device_id raw[16];
        size_t qsz = param_value_size <= sizeof(raw) ? param_value_size : sizeof(raw);
        cl_int r = g_real.clGetProgramInfo(rp, param_name, qsz, raw, &sz);
        if (param_value_size_ret) *param_value_size_ret = sz;
        if (r == CL_SUCCESS) {
            size_t n = sz / sizeof(cl_device_id);
            cl_device_id *out = (cl_device_id *)param_value;
            for (size_t i = 0; i < n; i++) out[i] = (cl_device_id)hy_wrap(HY_OBJ_DEVICE, raw[i], 0);
        }
        return r;
    }
    return g_real.clGetProgramInfo(rp, param_name, param_value_size, param_value, param_value_size_ret);
}

CL_API_ENTRY cl_int CL_API_CALL hy_clGetProgramBuildInfo(cl_program program, cl_device_id device, cl_program_build_info param_name, size_t param_value_size, void *param_value, size_t *param_value_size_ret) {
    ensure_init();
    return g_real.clGetProgramBuildInfo((cl_program)hy_unwrap(program), (cl_device_id)hy_unwrap(device), param_name, param_value_size, param_value, param_value_size_ret);
}

CL_API_ENTRY cl_kernel CL_API_CALL hy_clCreateKernel(cl_program program, const char *kernel_name, cl_int *errcode_ret) {
    ensure_init();
    cl_kernel rk = g_real.clCreateKernel((cl_program)hy_unwrap(program), kernel_name, errcode_ret);
    return (cl_kernel)hy_wrap(HY_OBJ_KERNEL, rk, 1);
}

CL_API_ENTRY cl_int CL_API_CALL hy_clCreateKernelsInProgram(cl_program program, cl_uint num_kernels, cl_kernel *kernels, cl_uint *num_kernels_ret) {
    ensure_init();
    cl_kernel raw[64];
    cl_kernel *heap = NULL, *dst = raw;
    if (kernels && num_kernels > 64) {
        heap = (cl_kernel *)malloc((size_t)num_kernels * sizeof(cl_kernel));
        if (!heap) return CL_OUT_OF_HOST_MEMORY;
        dst = heap;
    }
    cl_uint n = 0;
    cl_int r = g_real.clCreateKernelsInProgram((cl_program)hy_unwrap(program), num_kernels, kernels ? dst : NULL, &n);
    if (num_kernels_ret) *num_kernels_ret = n;
    if (r == CL_SUCCESS && kernels && num_kernels > 0) {
        cl_uint c = n < num_kernels ? n : num_kernels;
        for (cl_uint i = 0; i < c; i++) kernels[i] = (cl_kernel)hy_wrap(HY_OBJ_KERNEL, dst[i], 1);
    }
    free(heap);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clRetainKernel(cl_kernel kernel) {
    ensure_init();
    cl_int r = g_real.clRetainKernel((cl_kernel)hy_unwrap(kernel));
    if (r == CL_SUCCESS) hy_retain_obj(kernel);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clReleaseKernel(cl_kernel kernel) {
    ensure_init();
    int sf = 0;
    void *raw = hy_unwrap(kernel);
    hy_cl_obj *obj = hy_release_prepare(kernel, &sf);
    cl_int r = g_real.clReleaseKernel((cl_kernel)raw);
    if (sf) free(obj);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clSetKernelArg(cl_kernel kernel, cl_uint arg_index, size_t arg_size, const void *arg_value) {
    ensure_init();
    cl_kernel rk = (cl_kernel)hy_unwrap(kernel);
    if (arg_size == sizeof(void *) && arg_value != NULL) {
        void *cand = NULL;
        memcpy(&cand, arg_value, sizeof(void *));
        void *real_arg = hy_try_unwrap_kernel_arg_ptr(cand);
        if (real_arg != NULL) {
            return g_real.clSetKernelArg(rk, arg_index, arg_size, &real_arg);
        }
    }
    return g_real.clSetKernelArg(rk, arg_index, arg_size, arg_value);
}

CL_API_ENTRY cl_int CL_API_CALL hy_clGetKernelInfo(cl_kernel kernel, cl_kernel_info param_name, size_t param_value_size, void *param_value, size_t *param_value_size_ret) {
    ensure_init();
    cl_kernel rk = (cl_kernel)hy_unwrap(kernel);
    if (param_name == CL_KERNEL_CONTEXT || param_name == CL_KERNEL_PROGRAM) {
        void *rp = NULL;
        cl_int r = g_real.clGetKernelInfo(rk, param_name, sizeof(rp), &rp, NULL);
        if (r != CL_SUCCESS) return r;
        if (param_value_size_ret) *param_value_size_ret = sizeof(void *);
        if (param_value) {
            if (param_value_size < sizeof(void *)) return CL_INVALID_VALUE;
            *(void **)param_value = hy_wrap(param_name == CL_KERNEL_CONTEXT ? HY_OBJ_CONTEXT : HY_OBJ_PROGRAM, rp, 0);
        }
        return CL_SUCCESS;
    }
    return g_real.clGetKernelInfo(rk, param_name, param_value_size, param_value, param_value_size_ret);
}

CL_API_ENTRY cl_int CL_API_CALL hy_clGetKernelArgInfo(cl_kernel kernel, cl_uint arg_indx, cl_kernel_arg_info param_name, size_t param_value_size, void *param_value, size_t *param_value_size_ret) {
    ensure_init();
    if (!g_real.clGetKernelArgInfo) return CL_INVALID_OPERATION;
    return g_real.clGetKernelArgInfo((cl_kernel)hy_unwrap(kernel), arg_indx, param_name, param_value_size, param_value, param_value_size_ret);
}

CL_API_ENTRY cl_int CL_API_CALL hy_clGetKernelWorkGroupInfo(cl_kernel kernel, cl_device_id device, cl_kernel_work_group_info param_name, size_t param_value_size, void *param_value, size_t *param_value_size_ret) {
    ensure_init();
    return g_real.clGetKernelWorkGroupInfo((cl_kernel)hy_unwrap(kernel), (cl_device_id)hy_unwrap(device), param_name, param_value_size, param_value, param_value_size_ret);
}

CL_API_ENTRY cl_int CL_API_CALL hy_clGetKernelSubGroupInfoKHR(cl_kernel kernel, cl_device_id device, cl_kernel_sub_group_info param_name, size_t input_value_size, const void *input_value, size_t param_value_size, void *param_value, size_t *param_value_size_ret) {
    ensure_init();
    if (!g_real.clGetKernelSubGroupInfoKHR) return CL_INVALID_OPERATION;
    return g_real.clGetKernelSubGroupInfoKHR((cl_kernel)hy_unwrap(kernel), (cl_device_id)hy_unwrap(device), param_name, input_value_size, input_value, param_value_size, param_value, param_value_size_ret);
}

CL_API_ENTRY cl_int CL_API_CALL hy_clWaitForEvents(cl_uint num_events, const cl_event *event_list) {
    ensure_init();
    void *sevs[16], **hevs = NULL;
    const cl_event *revs = (const cl_event *)unwrap_list_16(num_events, (const void *const *)event_list, sevs, &hevs);
    cl_int r = g_real.clWaitForEvents(num_events, revs);
    free(hevs);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clGetEventInfo(cl_event event, cl_event_info param_name, size_t param_value_size, void *param_value, size_t *param_value_size_ret) {
    ensure_init();
    cl_event rev = (cl_event)hy_unwrap(event);
    if (param_name == CL_EVENT_CONTEXT || param_name == CL_EVENT_COMMAND_QUEUE) {
        void *rp = NULL;
        cl_int r = g_real.clGetEventInfo(rev, param_name, sizeof(rp), &rp, NULL);
        if (r != CL_SUCCESS) return r;
        if (param_value_size_ret) *param_value_size_ret = sizeof(void *);
        if (param_value) {
            if (param_value_size < sizeof(void *)) return CL_INVALID_VALUE;
            *(void **)param_value = rp ? hy_wrap(param_name == CL_EVENT_CONTEXT ? HY_OBJ_CONTEXT : HY_OBJ_QUEUE, rp, 0) : NULL;
        }
        return CL_SUCCESS;
    }
    return g_real.clGetEventInfo(rev, param_name, param_value_size, param_value, param_value_size_ret);
}

CL_API_ENTRY cl_event CL_API_CALL hy_clCreateUserEvent(cl_context context, cl_int *errcode_ret) {
    ensure_init();
    cl_event rev = g_real.clCreateUserEvent((cl_context)hy_unwrap(context), errcode_ret);
    return (cl_event)hy_wrap(HY_OBJ_EVENT, rev, 1);
}

CL_API_ENTRY cl_int CL_API_CALL hy_clRetainEvent(cl_event event) {
    ensure_init();
    cl_int r = g_real.clRetainEvent((cl_event)hy_unwrap(event));
    if (r == CL_SUCCESS) hy_retain_obj(event);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clReleaseEvent(cl_event event) {
    ensure_init();
    int sf = 0;
    void *raw = hy_unwrap(event);
    hy_cl_obj *obj = hy_release_prepare(event, &sf);
    cl_int r = g_real.clReleaseEvent((cl_event)raw);
    if (sf) free(obj);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clSetUserEventStatus(cl_event event, cl_int status) {
    ensure_init();
    return g_real.clSetUserEventStatus((cl_event)hy_unwrap(event), status);
}

typedef struct {
    void (CL_CALLBACK *pfn)(cl_event, cl_int, void *);
    void *user_data;
    cl_event wrapped;
} ev_cb_tramp_t;

static void CL_CALLBACK ev_notify_cb(cl_event raw_e, cl_int st, void *ud) {
    (void)raw_e;
    ev_cb_tramp_t *t = (ev_cb_tramp_t *)ud;
    if (!t) return;
    cl_event wrapped = t->wrapped;
    void (CL_CALLBACK *pfn)(cl_event, cl_int, void *) = t->pfn;
    void *user_data = t->user_data;
    free(t);
    if (pfn) pfn(wrapped, st, user_data);
    int sf = 0;
    hy_cl_obj *obj = hy_release_prepare(wrapped, &sf);
    if (sf) free(obj);
}

CL_API_ENTRY cl_int CL_API_CALL hy_clSetEventCallback(cl_event event, cl_int type, void (CL_CALLBACK *pfn_notify)(cl_event, cl_int, void *), void *user_data) {
    ensure_init();
    if (!pfn_notify) return CL_INVALID_VALUE;
    ev_cb_tramp_t *t = (ev_cb_tramp_t *)malloc(sizeof(ev_cb_tramp_t));
    if (!t) return CL_OUT_OF_HOST_MEMORY;
    t->pfn = pfn_notify;
    t->user_data = user_data;
    t->wrapped = event;
    hy_retain_obj(event);
    cl_int r = g_real.clSetEventCallback((cl_event)hy_unwrap(event), type, ev_notify_cb, t);
    if (r != CL_SUCCESS) {
        int sf = 0;
        hy_cl_obj *obj = hy_release_prepare(event, &sf);
        if (sf) free(obj);
        free(t);
    }
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clGetEventProfilingInfo(cl_event event, cl_profiling_info param_name, size_t param_value_size, void *param_value, size_t *param_value_size_ret) {
    ensure_init();
    return g_real.clGetEventProfilingInfo((cl_event)hy_unwrap(event), param_name, param_value_size, param_value, param_value_size_ret);
}

CL_API_ENTRY cl_int CL_API_CALL hy_clFlush(cl_command_queue cq) {
    ensure_init();
    return g_real.clFlush((cl_command_queue)hy_unwrap(cq));
}

CL_API_ENTRY cl_int CL_API_CALL hy_clFinish(cl_command_queue cq) {
    ensure_init();
    return g_real.clFinish((cl_command_queue)hy_unwrap(cq));
}

#define ENQ_BEGIN() \
    ensure_init(); \
    void *sevs[16], **hevs = NULL; \
    const cl_event *revs = (const cl_event *)unwrap_list_16(num_events_in_wait_list, (const void *const *)event_wait_list, sevs, &hevs); \
    cl_event real_ev = NULL; \
    cl_event *pev = event ? &real_ev : NULL;

#define ENQ_END(r) \
    free(hevs); \
    if (event) *event = ((r) == CL_SUCCESS && real_ev) ? (cl_event)hy_wrap(HY_OBJ_EVENT, real_ev, 1) : NULL;

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueReadBuffer(cl_command_queue cq, cl_mem buffer, cl_bool blocking, size_t offset, size_t size, void *ptr, cl_uint num_events_in_wait_list, const cl_event *event_wait_list, cl_event *event) {
    ENQ_BEGIN();
    cl_int r = g_real.clEnqueueReadBuffer((cl_command_queue)hy_unwrap(cq), (cl_mem)hy_unwrap(buffer), blocking, offset, size, ptr, num_events_in_wait_list, revs, pev);
    ENQ_END(r);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueReadBufferRect(cl_command_queue cq, cl_mem buffer, cl_bool blocking, const size_t *bo, const size_t *ho, const size_t *reg, size_t brp, size_t bsp, size_t hrp, size_t hsp, void *ptr, cl_uint num_events_in_wait_list, const cl_event *event_wait_list, cl_event *event) {
    ENQ_BEGIN();
    cl_int r = g_real.clEnqueueReadBufferRect((cl_command_queue)hy_unwrap(cq), (cl_mem)hy_unwrap(buffer), blocking, bo, ho, reg, brp, bsp, hrp, hsp, ptr, num_events_in_wait_list, revs, pev);
    ENQ_END(r);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueWriteBuffer(cl_command_queue cq, cl_mem buffer, cl_bool blocking, size_t offset, size_t size, const void *ptr, cl_uint num_events_in_wait_list, const cl_event *event_wait_list, cl_event *event) {
    ENQ_BEGIN();
    cl_int r = g_real.clEnqueueWriteBuffer((cl_command_queue)hy_unwrap(cq), (cl_mem)hy_unwrap(buffer), blocking, offset, size, ptr, num_events_in_wait_list, revs, pev);
    ENQ_END(r);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueWriteBufferRect(cl_command_queue cq, cl_mem buffer, cl_bool blocking, const size_t *bo, const size_t *ho, const size_t *reg, size_t brp, size_t bsp, size_t hrp, size_t hsp, const void *ptr, cl_uint num_events_in_wait_list, const cl_event *event_wait_list, cl_event *event) {
    ENQ_BEGIN();
    cl_int r = g_real.clEnqueueWriteBufferRect((cl_command_queue)hy_unwrap(cq), (cl_mem)hy_unwrap(buffer), blocking, bo, ho, reg, brp, bsp, hrp, hsp, ptr, num_events_in_wait_list, revs, pev);
    ENQ_END(r);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueFillBuffer(cl_command_queue cq, cl_mem buffer, const void *pattern, size_t pattern_size, size_t offset, size_t size, cl_uint num_events_in_wait_list, const cl_event *event_wait_list, cl_event *event) {
    ENQ_BEGIN();
    cl_int r = g_real.clEnqueueFillBuffer((cl_command_queue)hy_unwrap(cq), (cl_mem)hy_unwrap(buffer), pattern, pattern_size, offset, size, num_events_in_wait_list, revs, pev);
    ENQ_END(r);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueCopyBuffer(cl_command_queue cq, cl_mem src, cl_mem dst, size_t src_off, size_t dst_off, size_t size, cl_uint num_events_in_wait_list, const cl_event *event_wait_list, cl_event *event) {
    ENQ_BEGIN();
    cl_int r = g_real.clEnqueueCopyBuffer((cl_command_queue)hy_unwrap(cq), (cl_mem)hy_unwrap(src), (cl_mem)hy_unwrap(dst), src_off, dst_off, size, num_events_in_wait_list, revs, pev);
    ENQ_END(r);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueCopyBufferRect(cl_command_queue cq, cl_mem src, cl_mem dst, const size_t *so, const size_t *doff, const size_t *reg, size_t srp, size_t ssp, size_t drp, size_t dsp, cl_uint num_events_in_wait_list, const cl_event *event_wait_list, cl_event *event) {
    ENQ_BEGIN();
    cl_int r = g_real.clEnqueueCopyBufferRect((cl_command_queue)hy_unwrap(cq), (cl_mem)hy_unwrap(src), (cl_mem)hy_unwrap(dst), so, doff, reg, srp, ssp, drp, dsp, num_events_in_wait_list, revs, pev);
    ENQ_END(r);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueReadImage(cl_command_queue cq, cl_mem img, cl_bool blk, const size_t *origin, const size_t *region, size_t rp, size_t sp, void *ptr, cl_uint num_events_in_wait_list, const cl_event *event_wait_list, cl_event *event) {
    ENQ_BEGIN();
    cl_int r = g_real.clEnqueueReadImage((cl_command_queue)hy_unwrap(cq), (cl_mem)hy_unwrap(img), blk, origin, region, rp, sp, ptr, num_events_in_wait_list, revs, pev);
    ENQ_END(r);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueWriteImage(cl_command_queue cq, cl_mem img, cl_bool blk, const size_t *origin, const size_t *region, size_t rp, size_t sp, const void *ptr, cl_uint num_events_in_wait_list, const cl_event *event_wait_list, cl_event *event) {
    ENQ_BEGIN();
    cl_int r = g_real.clEnqueueWriteImage((cl_command_queue)hy_unwrap(cq), (cl_mem)hy_unwrap(img), blk, origin, region, rp, sp, ptr, num_events_in_wait_list, revs, pev);
    ENQ_END(r);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueFillImage(cl_command_queue cq, cl_mem img, const void *fill_color, const size_t *origin, const size_t *region, cl_uint num_events_in_wait_list, const cl_event *event_wait_list, cl_event *event) {
    ENQ_BEGIN();
    cl_int r = g_real.clEnqueueFillImage((cl_command_queue)hy_unwrap(cq), (cl_mem)hy_unwrap(img), fill_color, origin, region, num_events_in_wait_list, revs, pev);
    ENQ_END(r);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueCopyImage(cl_command_queue cq, cl_mem src, cl_mem dst, const size_t *so, const size_t *doff, const size_t *reg, cl_uint num_events_in_wait_list, const cl_event *event_wait_list, cl_event *event) {
    ENQ_BEGIN();
    cl_int r = g_real.clEnqueueCopyImage((cl_command_queue)hy_unwrap(cq), (cl_mem)hy_unwrap(src), (cl_mem)hy_unwrap(dst), so, doff, reg, num_events_in_wait_list, revs, pev);
    ENQ_END(r);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueCopyImageToBuffer(cl_command_queue cq, cl_mem src, cl_mem dst, const size_t *so, const size_t *reg, size_t doff, cl_uint num_events_in_wait_list, const cl_event *event_wait_list, cl_event *event) {
    ENQ_BEGIN();
    cl_int r = g_real.clEnqueueCopyImageToBuffer((cl_command_queue)hy_unwrap(cq), (cl_mem)hy_unwrap(src), (cl_mem)hy_unwrap(dst), so, reg, doff, num_events_in_wait_list, revs, pev);
    ENQ_END(r);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueCopyBufferToImage(cl_command_queue cq, cl_mem src, cl_mem dst, size_t soff, const size_t *doff, const size_t *reg, cl_uint num_events_in_wait_list, const cl_event *event_wait_list, cl_event *event) {
    ENQ_BEGIN();
    cl_int r = g_real.clEnqueueCopyBufferToImage((cl_command_queue)hy_unwrap(cq), (cl_mem)hy_unwrap(src), (cl_mem)hy_unwrap(dst), soff, doff, reg, num_events_in_wait_list, revs, pev);
    ENQ_END(r);
    return r;
}

CL_API_ENTRY void * CL_API_CALL hy_clEnqueueMapBuffer(cl_command_queue cq, cl_mem buffer, cl_bool blocking, cl_map_flags flags, size_t offset, size_t size, cl_uint num_events_in_wait_list, const cl_event *event_wait_list, cl_event *event, cl_int *errcode_ret) {
    ENQ_BEGIN();
    cl_int le = CL_SUCCESS;
    void *ptr = g_real.clEnqueueMapBuffer((cl_command_queue)hy_unwrap(cq), (cl_mem)hy_unwrap(buffer), blocking, flags, offset, size, num_events_in_wait_list, revs, pev, &le);
    if (errcode_ret) *errcode_ret = le;
    ENQ_END(le);
    return ptr;
}

CL_API_ENTRY void * CL_API_CALL hy_clEnqueueMapImage(cl_command_queue cq, cl_mem img, cl_bool blocking, cl_map_flags flags, const size_t *origin, const size_t *region, size_t *row_pitch, size_t *slice_pitch, cl_uint num_events_in_wait_list, const cl_event *event_wait_list, cl_event *event, cl_int *errcode_ret) {
    ENQ_BEGIN();
    cl_int le = CL_SUCCESS;
    void *ptr = g_real.clEnqueueMapImage((cl_command_queue)hy_unwrap(cq), (cl_mem)hy_unwrap(img), blocking, flags, origin, region, row_pitch, slice_pitch, num_events_in_wait_list, revs, pev, &le);
    if (errcode_ret) *errcode_ret = le;
    ENQ_END(le);
    return ptr;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueUnmapMemObject(cl_command_queue cq, cl_mem memobj, void *mapped_ptr, cl_uint num_events_in_wait_list, const cl_event *event_wait_list, cl_event *event) {
    ENQ_BEGIN();
    cl_int r = g_real.clEnqueueUnmapMemObject((cl_command_queue)hy_unwrap(cq), (cl_mem)hy_unwrap(memobj), mapped_ptr, num_events_in_wait_list, revs, pev);
    ENQ_END(r);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueMigrateMemObjects(cl_command_queue cq, cl_uint num_mem_objects, const cl_mem *mem_objects, cl_mem_migration_flags flags, cl_uint num_events_in_wait_list, const cl_event *event_wait_list, cl_event *event) {
    ENQ_BEGIN();
    void *smems[16], **hmems = NULL;
    const cl_mem *rmems = (const cl_mem *)unwrap_list_16(num_mem_objects, (const void *const *)mem_objects, smems, &hmems);
    cl_int r = g_real.clEnqueueMigrateMemObjects((cl_command_queue)hy_unwrap(cq), num_mem_objects, rmems, flags, num_events_in_wait_list, revs, pev);
    free(hmems);
    ENQ_END(r);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueNDRangeKernel(cl_command_queue cq, cl_kernel kernel, cl_uint work_dim, const size_t *gwo, const size_t *gws, const size_t *lws, cl_uint num_events_in_wait_list, const cl_event *event_wait_list, cl_event *event) {
    ENQ_BEGIN();
    cl_int r = g_real.clEnqueueNDRangeKernel((cl_command_queue)hy_unwrap(cq), (cl_kernel)hy_unwrap(kernel), work_dim, gwo, gws, lws, num_events_in_wait_list, revs, pev);
    ENQ_END(r);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueTask(cl_command_queue cq, cl_kernel kernel, cl_uint num_events_in_wait_list, const cl_event *event_wait_list, cl_event *event) {
    ENQ_BEGIN();
    cl_int r = g_real.clEnqueueTask((cl_command_queue)hy_unwrap(cq), (cl_kernel)hy_unwrap(kernel), num_events_in_wait_list, revs, pev);
    ENQ_END(r);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueNativeKernel(cl_command_queue cq, void (CL_CALLBACK *user_func)(void *), void *args, size_t cb_args, cl_uint num_mem_objects, const cl_mem *mem_list, const void **args_mem_loc, cl_uint num_events_in_wait_list, const cl_event *event_wait_list, cl_event *event) {
    ENQ_BEGIN();
    void *smems[16], **hmems = NULL;
    const cl_mem *rmems = (const cl_mem *)unwrap_list_16(num_mem_objects, (const void *const *)mem_list, smems, &hmems);
    cl_int r = g_real.clEnqueueNativeKernel ? g_real.clEnqueueNativeKernel((cl_command_queue)hy_unwrap(cq), user_func, args, cb_args, num_mem_objects, rmems, args_mem_loc, num_events_in_wait_list, revs, pev) : CL_INVALID_OPERATION;
    free(hmems);
    ENQ_END(r);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueMarker(cl_command_queue cq, cl_event *event) {
    ensure_init();
    cl_event rev = NULL;
    cl_int r = g_real.clEnqueueMarker((cl_command_queue)hy_unwrap(cq), event ? &rev : NULL);
    if (event) *event = (r == CL_SUCCESS && rev) ? (cl_event)hy_wrap(HY_OBJ_EVENT, rev, 1) : NULL;
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueMarkerWithWaitList(cl_command_queue cq, cl_uint num_events_in_wait_list, const cl_event *event_wait_list, cl_event *event) {
    ENQ_BEGIN();
    cl_int r = g_real.clEnqueueMarkerWithWaitList((cl_command_queue)hy_unwrap(cq), num_events_in_wait_list, revs, pev);
    ENQ_END(r);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueWaitForEvents(cl_command_queue cq, cl_uint num_events, const cl_event *event_list) {
    ensure_init();
    void *sevs[16], **hevs = NULL;
    const cl_event *revs = (const cl_event *)unwrap_list_16(num_events, (const void *const *)event_list, sevs, &hevs);
    cl_int r = g_real.clEnqueueWaitForEvents((cl_command_queue)hy_unwrap(cq), num_events, revs);
    free(hevs);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueBarrier(cl_command_queue cq) {
    ensure_init();
    return g_real.clEnqueueBarrier((cl_command_queue)hy_unwrap(cq));
}

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueBarrierWithWaitList(cl_command_queue cq, cl_uint num_events_in_wait_list, const cl_event *event_wait_list, cl_event *event) {
    ENQ_BEGIN();
    cl_int r = g_real.clEnqueueBarrierWithWaitList((cl_command_queue)hy_unwrap(cq), num_events_in_wait_list, revs, pev);
    ENQ_END(r);
    return r;
}

CL_API_ENTRY cl_mem CL_API_CALL hy_clCreatePipe(cl_context ctx, cl_mem_flags flags, cl_uint packet_size, cl_uint max_packets, const cl_pipe_properties *props, cl_int *err) {
    ensure_init();
    if (!g_real.clCreatePipe) { if (err) *err = CL_INVALID_OPERATION; return NULL; }
    cl_mem rm = g_real.clCreatePipe((cl_context)hy_unwrap(ctx), flags, packet_size, max_packets, props, err);
    return (cl_mem)hy_wrap(HY_OBJ_MEM, rm, 1);
}

CL_API_ENTRY cl_int CL_API_CALL hy_clGetPipeInfo(cl_mem pipe, cl_pipe_info param_name, size_t sz, void *val, size_t *sz_ret) {
    ensure_init();
    return g_real.clGetPipeInfo ? g_real.clGetPipeInfo((cl_mem)hy_unwrap(pipe), param_name, sz, val, sz_ret) : CL_INVALID_OPERATION;
}

CL_API_ENTRY void * CL_API_CALL hy_clSVMAlloc(cl_context ctx, cl_svm_mem_flags flags, size_t size, cl_uint align) {
    ensure_init();
    return g_real.clSVMAlloc ? g_real.clSVMAlloc((cl_context)hy_unwrap(ctx), flags, size, align) : NULL;
}

CL_API_ENTRY void CL_API_CALL hy_clSVMFree(cl_context ctx, void *ptr) {
    ensure_init();
    if (g_real.clSVMFree) g_real.clSVMFree((cl_context)hy_unwrap(ctx), ptr);
}

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueSVMFree(cl_command_queue cq, cl_uint num_svm_pointers, void *svm_pointers[], void (CL_CALLBACK *pfn_free_func)(cl_command_queue, cl_uint, void *[], void *), void *user_data, cl_uint num_events_in_wait_list, const cl_event *event_wait_list, cl_event *event) {
    ENQ_BEGIN();
    cl_int r = g_real.clEnqueueSVMFree ? g_real.clEnqueueSVMFree((cl_command_queue)hy_unwrap(cq), num_svm_pointers, svm_pointers, pfn_free_func, user_data, num_events_in_wait_list, revs, pev) : CL_INVALID_OPERATION;
    ENQ_END(r);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueSVMMemcpy(cl_command_queue cq, cl_bool blk, void *dst, const void *src, size_t size, cl_uint num_events_in_wait_list, const cl_event *event_wait_list, cl_event *event) {
    ENQ_BEGIN();
    cl_int r = g_real.clEnqueueSVMMemcpy ? g_real.clEnqueueSVMMemcpy((cl_command_queue)hy_unwrap(cq), blk, dst, src, size, num_events_in_wait_list, revs, pev) : CL_INVALID_OPERATION;
    ENQ_END(r);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueSVMMemFill(cl_command_queue cq, void *svm_ptr, const void *pat, size_t pat_sz, size_t size, cl_uint num_events_in_wait_list, const cl_event *event_wait_list, cl_event *event) {
    ENQ_BEGIN();
    cl_int r = g_real.clEnqueueSVMMemFill ? g_real.clEnqueueSVMMemFill((cl_command_queue)hy_unwrap(cq), svm_ptr, pat, pat_sz, size, num_events_in_wait_list, revs, pev) : CL_INVALID_OPERATION;
    ENQ_END(r);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueSVMMap(cl_command_queue cq, cl_bool blk, cl_map_flags flags, void *svm_ptr, size_t size, cl_uint num_events_in_wait_list, const cl_event *event_wait_list, cl_event *event) {
    ENQ_BEGIN();
    cl_int r = g_real.clEnqueueSVMMap ? g_real.clEnqueueSVMMap((cl_command_queue)hy_unwrap(cq), blk, flags, svm_ptr, size, num_events_in_wait_list, revs, pev) : CL_INVALID_OPERATION;
    ENQ_END(r);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueSVMUnmap(cl_command_queue cq, void *svm_ptr, cl_uint num_events_in_wait_list, const cl_event *event_wait_list, cl_event *event) {
    ENQ_BEGIN();
    cl_int r = g_real.clEnqueueSVMUnmap ? g_real.clEnqueueSVMUnmap((cl_command_queue)hy_unwrap(cq), svm_ptr, num_events_in_wait_list, revs, pev) : CL_INVALID_OPERATION;
    ENQ_END(r);
    return r;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clSetKernelArgSVMPointer(cl_kernel kernel, cl_uint idx, const void *arg_value) {
    ensure_init();
    return g_real.clSetKernelArgSVMPointer ? g_real.clSetKernelArgSVMPointer((cl_kernel)hy_unwrap(kernel), idx, arg_value) : CL_INVALID_OPERATION;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clSetKernelExecInfo(cl_kernel kernel, cl_kernel_exec_info param_name, size_t sz, const void *val) {
    ensure_init();
    return g_real.clSetKernelExecInfo ? g_real.clSetKernelExecInfo((cl_kernel)hy_unwrap(kernel), param_name, sz, val) : CL_INVALID_OPERATION;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clSetPerfHintQCOM(cl_context ctx, cl_uint hint) {
    ensure_init();
    return g_real.clSetPerfHintQCOM ? g_real.clSetPerfHintQCOM((cl_context)hy_unwrap(ctx), hint) : CL_INVALID_OPERATION;
}

CL_API_ENTRY void * CL_API_CALL hy_clGetExtensionFunctionAddress(const char *func_name) {
    ensure_init();
    if (!func_name) return NULL;
    if (strcmp(func_name, "clIcdGetPlatformIDsKHR") == 0) return (void *)hy_clIcdGetPlatformIDsKHR;
    if (strcmp(func_name, "clGetKernelSubGroupInfoKHR") == 0) return (void *)hy_clGetKernelSubGroupInfoKHR;
    if (strcmp(func_name, "clCreateCommandQueueWithProperties") == 0) return (void *)hy_clCreateCommandQueueWithProperties;
    if (strcmp(func_name, "clCreateCommandQueueWithPropertiesKHR") == 0) return (void *)hy_clCreateCommandQueueWithProperties;
    if (strcmp(func_name, "clSetPerfHintQCOM") == 0) return (void *)hy_clSetPerfHintQCOM;
    return NULL;
}

CL_API_ENTRY void * CL_API_CALL hy_clGetExtensionFunctionAddressForPlatform(cl_platform_id platform, const char *func_name) {
    (void)platform;
    return hy_clGetExtensionFunctionAddress(func_name);
}

CL_API_ENTRY cl_kernel CL_API_CALL hy_clCloneKernel(cl_kernel src, cl_int *err) {
    (void)src;
    if (err) *err = CL_INVALID_OPERATION;
    return NULL;
}

CL_API_ENTRY cl_program CL_API_CALL hy_clCreateProgramWithIL(cl_context ctx, const void *il, size_t len, cl_int *err) {
    (void)ctx; (void)il; (void)len;
    if (err) *err = CL_INVALID_OPERATION;
    return NULL;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clEnqueueSVMMigrateMem(cl_command_queue cq, cl_uint n, const void **ptrs, const size_t *sz, cl_mem_migration_flags fl, cl_uint num_events_in_wait_list, const cl_event *event_wait_list, cl_event *event) {
    (void)cq; (void)n; (void)ptrs; (void)sz; (void)fl; (void)num_events_in_wait_list; (void)event_wait_list;
    if (event) *event = NULL;
    return CL_INVALID_OPERATION;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clGetDeviceAndHostTimer(cl_device_id d, cl_ulong *dt, cl_ulong *ht) {
    (void)d; (void)dt; (void)ht;
    return CL_INVALID_OPERATION;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clGetHostTimer(cl_device_id d, cl_ulong *ht) {
    (void)d; (void)ht;
    return CL_INVALID_OPERATION;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clGetKernelSubGroupInfo(cl_kernel kernel, cl_device_id device, cl_kernel_sub_group_info param_name, size_t input_value_size, const void *input_value, size_t param_value_size, void *param_value, size_t *param_value_size_ret) {
    return hy_clGetKernelSubGroupInfoKHR(kernel, device, param_name, input_value_size, input_value, param_value_size, param_value, param_value_size_ret);
}

CL_API_ENTRY cl_int CL_API_CALL hy_clSetDefaultDeviceCommandQueue(cl_context ctx, cl_device_id d, cl_command_queue cq) {
    (void)ctx; (void)d; (void)cq;
    return CL_INVALID_OPERATION;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clSetProgramReleaseCallback(cl_program p, void (CL_CALLBACK *cb)(cl_program, void *), void *ud) {
    (void)p; (void)cb; (void)ud;
    return CL_INVALID_OPERATION;
}

CL_API_ENTRY cl_int CL_API_CALL hy_clSetProgramSpecializationConstant(cl_program p, cl_uint id, size_t sz, const void *v) {
    (void)p; (void)id; (void)sz; (void)v;
    return CL_INVALID_OPERATION;
}

CL_API_ENTRY cl_mem CL_API_CALL hy_clCreateBufferWithProperties(cl_context ctx, const cl_mem_properties *props, cl_mem_flags flags, size_t size, void *host_ptr, cl_int *err) {
    if (props && props[0] != 0) { if (err) *err = CL_INVALID_PROPERTY; return NULL; }
    return hy_clCreateBuffer(ctx, flags, size, host_ptr, err);
}

CL_API_ENTRY cl_mem CL_API_CALL hy_clCreateImageWithProperties(cl_context ctx, const cl_mem_properties *props, cl_mem_flags flags, const cl_image_format *fmt, const cl_image_desc *desc, void *host_ptr, cl_int *err) {
    if (props && props[0] != 0) { if (err) *err = CL_INVALID_PROPERTY; return NULL; }
    return hy_clCreateImage(ctx, flags, fmt, desc, host_ptr, err);
}

CL_API_ENTRY cl_int CL_API_CALL hy_clSetContextDestructorCallback(cl_context ctx, void (CL_CALLBACK *cb)(cl_context, void *), void *ud) {
    (void)ctx; (void)cb; (void)ud;
    return CL_INVALID_OPERATION;
}

static const cl_icd_dispatch g_icd_dispatch = {
    .clGetPlatformIDs = hy_clGetPlatformIDs,
    .clGetPlatformInfo = hy_clGetPlatformInfo,
    .clGetDeviceIDs = hy_clGetDeviceIDs,
    .clGetDeviceInfo = hy_clGetDeviceInfo,
    .clCreateContext = hy_clCreateContext,
    .clCreateContextFromType = hy_clCreateContextFromType,
    .clRetainContext = hy_clRetainContext,
    .clReleaseContext = hy_clReleaseContext,
    .clGetContextInfo = hy_clGetContextInfo,
    .clCreateCommandQueue = hy_clCreateCommandQueue,
    .clRetainCommandQueue = hy_clRetainCommandQueue,
    .clReleaseCommandQueue = hy_clReleaseCommandQueue,
    .clGetCommandQueueInfo = hy_clGetCommandQueueInfo,
    .clSetCommandQueueProperty = hy_clSetCommandQueueProperty,
    .clCreateBuffer = hy_clCreateBuffer,
    .clCreateImage2D = hy_clCreateImage2D,
    .clCreateImage3D = hy_clCreateImage3D,
    .clRetainMemObject = hy_clRetainMemObject,
    .clReleaseMemObject = hy_clReleaseMemObject,
    .clGetSupportedImageFormats = hy_clGetSupportedImageFormats,
    .clGetMemObjectInfo = hy_clGetMemObjectInfo,
    .clGetImageInfo = hy_clGetImageInfo,
    .clCreateSampler = hy_clCreateSampler,
    .clRetainSampler = hy_clRetainSampler,
    .clReleaseSampler = hy_clReleaseSampler,
    .clGetSamplerInfo = hy_clGetSamplerInfo,
    .clCreateProgramWithSource = hy_clCreateProgramWithSource,
    .clCreateProgramWithBinary = hy_clCreateProgramWithBinary,
    .clRetainProgram = hy_clRetainProgram,
    .clReleaseProgram = hy_clReleaseProgram,
    .clBuildProgram = hy_clBuildProgram,
    .clUnloadCompiler = hy_clUnloadCompiler,
    .clGetProgramInfo = hy_clGetProgramInfo,
    .clGetProgramBuildInfo = hy_clGetProgramBuildInfo,
    .clCreateKernel = hy_clCreateKernel,
    .clCreateKernelsInProgram = hy_clCreateKernelsInProgram,
    .clRetainKernel = hy_clRetainKernel,
    .clReleaseKernel = hy_clReleaseKernel,
    .clSetKernelArg = hy_clSetKernelArg,
    .clGetKernelInfo = hy_clGetKernelInfo,
    .clGetKernelWorkGroupInfo = hy_clGetKernelWorkGroupInfo,
    .clWaitForEvents = hy_clWaitForEvents,
    .clGetEventInfo = hy_clGetEventInfo,
    .clRetainEvent = hy_clRetainEvent,
    .clReleaseEvent = hy_clReleaseEvent,
    .clGetEventProfilingInfo = hy_clGetEventProfilingInfo,
    .clFlush = hy_clFlush,
    .clFinish = hy_clFinish,
    .clEnqueueReadBuffer = hy_clEnqueueReadBuffer,
    .clEnqueueWriteBuffer = hy_clEnqueueWriteBuffer,
    .clEnqueueCopyBuffer = hy_clEnqueueCopyBuffer,
    .clEnqueueReadImage = hy_clEnqueueReadImage,
    .clEnqueueWriteImage = hy_clEnqueueWriteImage,
    .clEnqueueCopyImage = hy_clEnqueueCopyImage,
    .clEnqueueCopyImageToBuffer = hy_clEnqueueCopyImageToBuffer,
    .clEnqueueCopyBufferToImage = hy_clEnqueueCopyBufferToImage,
    .clEnqueueMapBuffer = hy_clEnqueueMapBuffer,
    .clEnqueueMapImage = hy_clEnqueueMapImage,
    .clEnqueueUnmapMemObject = hy_clEnqueueUnmapMemObject,
    .clEnqueueNDRangeKernel = hy_clEnqueueNDRangeKernel,
    .clEnqueueTask = hy_clEnqueueTask,
    .clEnqueueNativeKernel = hy_clEnqueueNativeKernel,
    .clEnqueueMarker = hy_clEnqueueMarker,
    .clEnqueueWaitForEvents = hy_clEnqueueWaitForEvents,
    .clEnqueueBarrier = hy_clEnqueueBarrier,
    .clGetExtensionFunctionAddress = hy_clGetExtensionFunctionAddress,
    .clSetEventCallback = hy_clSetEventCallback,
    .clCreateSubBuffer = hy_clCreateSubBuffer,
    .clSetMemObjectDestructorCallback = hy_clSetMemObjectDestructorCallback,
    .clCreateUserEvent = hy_clCreateUserEvent,
    .clSetUserEventStatus = hy_clSetUserEventStatus,
    .clEnqueueReadBufferRect = hy_clEnqueueReadBufferRect,
    .clEnqueueWriteBufferRect = hy_clEnqueueWriteBufferRect,
    .clEnqueueCopyBufferRect = hy_clEnqueueCopyBufferRect,
    .clCreateSubDevices = hy_clCreateSubDevices,
    .clRetainDevice = hy_clRetainDevice,
    .clReleaseDevice = hy_clReleaseDevice,
    .clCreateImage = hy_clCreateImage,
    .clCreateProgramWithBuiltInKernels = hy_clCreateProgramWithBuiltInKernels,
    .clCompileProgram = hy_clCompileProgram,
    .clLinkProgram = hy_clLinkProgram,
    .clUnloadPlatformCompiler = hy_clUnloadPlatformCompiler,
    .clGetKernelArgInfo = hy_clGetKernelArgInfo,
    .clEnqueueFillBuffer = hy_clEnqueueFillBuffer,
    .clEnqueueFillImage = hy_clEnqueueFillImage,
    .clEnqueueMigrateMemObjects = hy_clEnqueueMigrateMemObjects,
    .clEnqueueMarkerWithWaitList = hy_clEnqueueMarkerWithWaitList,
    .clEnqueueBarrierWithWaitList = hy_clEnqueueBarrierWithWaitList,
    .clGetExtensionFunctionAddressForPlatform = hy_clGetExtensionFunctionAddressForPlatform,
    .clCreateCommandQueueWithProperties = hy_clCreateCommandQueueWithProperties,
    .clCreatePipe = hy_clCreatePipe,
    .clGetPipeInfo = hy_clGetPipeInfo,
    .clSVMAlloc = hy_clSVMAlloc,
    .clSVMFree = hy_clSVMFree,
    .clEnqueueSVMFree = hy_clEnqueueSVMFree,
    .clEnqueueSVMMemcpy = hy_clEnqueueSVMMemcpy,
    .clEnqueueSVMMemFill = hy_clEnqueueSVMMemFill,
    .clEnqueueSVMMap = hy_clEnqueueSVMMap,
    .clEnqueueSVMUnmap = hy_clEnqueueSVMUnmap,
    .clCreateSamplerWithProperties = hy_clCreateSamplerWithProperties,
    .clSetKernelArgSVMPointer = hy_clSetKernelArgSVMPointer,
    .clSetKernelExecInfo = hy_clSetKernelExecInfo,
    .clGetKernelSubGroupInfoKHR = hy_clGetKernelSubGroupInfoKHR,
    .clCloneKernel = hy_clCloneKernel,
    .clCreateProgramWithIL = hy_clCreateProgramWithIL,
    .clEnqueueSVMMigrateMem = hy_clEnqueueSVMMigrateMem,
    .clGetDeviceAndHostTimer = hy_clGetDeviceAndHostTimer,
    .clGetHostTimer = hy_clGetHostTimer,
    .clGetKernelSubGroupInfo = hy_clGetKernelSubGroupInfo,
    .clSetDefaultDeviceCommandQueue = hy_clSetDefaultDeviceCommandQueue,
    .clSetProgramReleaseCallback = hy_clSetProgramReleaseCallback,
    .clSetProgramSpecializationConstant = hy_clSetProgramSpecializationConstant,
    .clCreateBufferWithProperties = hy_clCreateBufferWithProperties,
    .clCreateImageWithProperties = hy_clCreateImageWithProperties,
    .clSetContextDestructorCallback = hy_clSetContextDestructorCallback,
};

/* Required Khronos ICD exported entry points */
CL_API_ENTRY cl_int CL_API_CALL clIcdGetPlatformIDsKHR(cl_uint n, cl_platform_id *p, cl_uint *np) { return hy_clIcdGetPlatformIDsKHR(n, p, np); }
CL_API_ENTRY cl_int CL_API_CALL clGetPlatformInfo(cl_platform_id p, cl_platform_info pn, size_t s, void *v, size_t *sr) { return hy_clGetPlatformInfo(p, pn, s, v, sr); }
CL_API_ENTRY void * CL_API_CALL clGetExtensionFunctionAddress(const char *f) { return hy_clGetExtensionFunctionAddress(f); }
CL_API_ENTRY cl_int CL_API_CALL clGetPlatformIDs(cl_uint n, cl_platform_id *p, cl_uint *np) { return hy_clGetPlatformIDs(n, p, np); }
