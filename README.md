本脚本基于 [ccbkkb/Snippet-B2-PicBed](https://github.com/ccbkkb/Snippet-B2-PicBed) 修改而来

**脚本作用：**
为 Backblaze B2 私有存储桶提供文件访问服务（常用于图床）。支持边缘缓存、自动 MIME 类型修正、图片 inline 显示，以及灵活的跨域来源控制。

**与原项目的主要区别：**
- 移除了签名验证和防盗链机制（无需 `?sign` 和 `?exp` 参数）
- 优化了 CORS 处理，支持精确域名 + 子域名通配白名单
- 修复了非预期状态码的响应透传问题（提升跨域一致性）
- 改进了响应头管理和错误处理逻辑
- 更适合需要直接公开访问的简单场景

本版本适用于不需要防盗链保护的使用场景。

**免责声明：**  
本脚本基于 MIT License 发布，**按原样提供，不提供任何明示或暗示的保证**。作者不对因使用本脚本而产生的任何问题、损失或责任承担责任。

---

This is a modified version of the Cloudflare Worker script from [ccbkkb/Snippet-B2-PicBed](https://github.com/ccbkkb/Snippet-B2-PicBed).

**What it does:**
Provides file access service for private Backblaze B2 storage buckets (commonly used as an image bed). It supports edge caching, automatic MIME type correction, forcing images to display inline, and flexible CORS origin control.

**Key differences from the original:**
- Removed the signature verification and anti-hotlink mechanism (no longer requires `?sign` and `?exp` parameters)
- Improved CORS handling with proper whitelist support (exact match + subdomain wildcard)
- Fixed passthrough response issues for non-standard status codes (better CORS consistency)
- Cleaner header management and more robust error handling
- More suitable for public/simple file serving scenarios

This version is intended for use cases where anti-hotlink protection is not required.

**Disclaimer:**  
This software is provided "AS IS", without warranty of any kind. The author assumes no liability for any damages or issues arising from its use.
