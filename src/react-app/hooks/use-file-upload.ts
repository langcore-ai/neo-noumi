"use client";

import {
  type ChangeEvent,
  type DragEvent,
  type InputHTMLAttributes,
  type RefObject,
  useCallback,
  useRef,
  useState,
} from "react";

export type FileMetadata = {
  /** 文件名。 */
  name: string;
  /** 文件大小，单位字节。 */
  size: number;
  /** MIME 类型。 */
  type: string;
  /** 预览地址。 */
  url: string;
  /** 前端列表使用的稳定 ID。 */
  id: string;
};

export type FileWithPreview = {
  /** 浏览器文件对象或已存在文件元数据。 */
  file: File | FileMetadata;
  /** 前端列表使用的稳定 ID。 */
  id: string;
  /** 可选预览地址。 */
  preview?: string;
};

export type FileUploadOptions = {
  /** 文件数量上限，仅 multiple 为 true 时生效。 */
  maxFiles?: number;
  /** 单文件大小上限，单位字节。 */
  maxSize?: number;
  /** input accept 规则。 */
  accept?: string;
  /** 是否允许多选。 */
  multiple?: boolean;
  /** 初始文件列表。 */
  initialFiles?: FileMetadata[];
  /** 文件列表变化回调。 */
  onFilesChange?: (files: FileWithPreview[]) => void;
  /** 新增有效文件回调。 */
  onFilesAdded?: (addedFiles: FileWithPreview[]) => void;
};

export type FileUploadState = {
  /** 当前选中的文件列表。 */
  files: FileWithPreview[];
  /** 是否正在拖拽悬停。 */
  isDragging: boolean;
  /** 校验错误列表。 */
  errors: string[];
};

export type FileUploadActions = {
  /** 添加文件。 */
  addFiles: (files: FileList | File[]) => void;
  /** 移除单个文件。 */
  removeFile: (id: string) => void;
  /** 清空文件列表。 */
  clearFiles: () => void;
  /** 清空错误。 */
  clearErrors: () => void;
  /** 处理拖拽进入。 */
  handleDragEnter: (e: DragEvent<HTMLElement>) => void;
  /** 处理拖拽离开。 */
  handleDragLeave: (e: DragEvent<HTMLElement>) => void;
  /** 处理拖拽悬停。 */
  handleDragOver: (e: DragEvent<HTMLElement>) => void;
  /** 处理拖拽释放。 */
  handleDrop: (e: DragEvent<HTMLElement>) => void;
  /** 处理 input 文件变化。 */
  handleFileChange: (e: ChangeEvent<HTMLInputElement>) => void;
  /** 打开文件选择器。 */
  openFileDialog: () => void;
  /** 获取 input 属性。 */
  getInputProps: (
    props?: InputHTMLAttributes<HTMLInputElement>,
  ) => InputHTMLAttributes<HTMLInputElement> & {
    /** 文件 input ref。 */
    ref: RefObject<HTMLInputElement | null>;
  };
};

/** 带浏览器文件夹相对路径的文件对象。 */
type FileWithDirectoryPath = File & {
  /** 文件夹选择时由浏览器写入的相对路径。 */
  webkitRelativePath?: string;
};

/**
 * 生成文件去重 key。
 * @param file 文件对象或元数据
 * @returns 去重 key
 */
function getFileIdentity(file: File | FileMetadata): string {
  const directoryFile = file as FileWithDirectoryPath;
  const path = directoryFile.webkitRelativePath || file.name;
  return `${path}\n${file.size}`;
}

/**
 * 管理文件上传选择、拖拽和基础校验状态。
 * @param options 上传配置
 * @returns 上传状态与操作方法
 */
export const useFileUpload = (
  options: FileUploadOptions = {},
): [FileUploadState, FileUploadActions] => {
  const {
    maxFiles = Number.POSITIVE_INFINITY,
    maxSize = Number.POSITIVE_INFINITY,
    accept = "*",
    multiple = false,
    initialFiles = [],
    onFilesChange,
    onFilesAdded,
  } = options;

  const [state, setState] = useState<FileUploadState>({
    errors: [],
    files: initialFiles.map((file) => ({
      file,
      id: file.id,
      preview: file.url,
    })),
    isDragging: false,
  });

  const inputRef = useRef<HTMLInputElement>(null);

  const validateFile = useCallback(
    (file: File | FileMetadata): string | null => {
      if (file instanceof File) {
        if (file.size > maxSize) {
          return `File "${file.name}" exceeds the maximum size of ${formatBytes(maxSize)}.`;
        }
      } else {
        if (file.size > maxSize) {
          return `File "${file.name}" exceeds the maximum size of ${formatBytes(maxSize)}.`;
        }
      }

      if (accept !== "*") {
        const acceptedTypes = accept.split(",").map((type) => type.trim());
        const fileType = file instanceof File ? file.type || "" : file.type;
        const fileExtension = `.${file instanceof File ? file.name.split(".").pop() : file.name.split(".").pop()}`;

        const isAccepted = acceptedTypes.some((type) => {
          if (type.startsWith(".")) {
            return fileExtension.toLowerCase() === type.toLowerCase();
          }
          if (type.endsWith("/*")) {
            const baseType = type.split("/")[0];
            return fileType.startsWith(`${baseType}/`);
          }
          return fileType === type;
        });

        if (!isAccepted) {
          return `File "${file instanceof File ? file.name : file.name}" is not an accepted file type.`;
        }
      }

      return null;
    },
    [accept, maxSize],
  );

  const createPreview = useCallback(
    (file: File | FileMetadata): string | undefined => {
      if (file instanceof File) {
        return URL.createObjectURL(file);
      }
      return file.url;
    },
    [],
  );

  const generateUniqueId = useCallback((file: File | FileMetadata): string => {
    if (file instanceof File) {
      return `${file.name}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    }
    return file.id;
  }, []);

  const clearFiles = useCallback(() => {
    setState((prev) => {
      // 清理预览 URL，避免图片预览占用浏览器内存。
      for (const file of prev.files ?? []) {
        if (
          file.preview &&
          file.file instanceof File &&
          file.file.type.startsWith("image/")
        ) {
          URL.revokeObjectURL(file.preview);
        }
      }

      if (inputRef.current) {
        inputRef.current.value = "";
      }

      const newState = {
        ...prev,
        errors: [],
        files: [],
      };

      onFilesChange?.(newState.files);
      return newState;
    });
  }, [onFilesChange]);

  const addFiles = useCallback(
    (newFiles: FileList | File[]) => {
      if (!newFiles || newFiles.length === 0) return;

      const newFilesArray = Array.from(newFiles);
      const errors: string[] = [];

      // 新增文件时先清空旧错误，避免用户已修正后仍看到历史错误。
      setState((prev) => ({ ...prev, errors: [] }));

      // 单文件模式下，新文件会替换旧文件。
      if (!multiple) {
        clearFiles();
      }

      // 多文件模式下需要先判断总数，避免部分写入造成状态不一致。
      if (
        multiple &&
        maxFiles !== Number.POSITIVE_INFINITY &&
        state.files.length + newFilesArray.length > maxFiles
      ) {
        errors.push(`You can only upload a maximum of ${maxFiles} files.`);
        setState((prev) => ({ ...prev, errors }));
        return;
      }

      const validFiles: FileWithPreview[] = [];

      for (const file of newFilesArray) {
        if (multiple) {
          const isDuplicate = state.files.some(
            (existingFile) =>
              getFileIdentity(existingFile.file) === getFileIdentity(file),
          );

          if (isDuplicate) {
            continue;
          }
        }

        if (file.size > maxSize) {
          errors.push(
            multiple
              ? `Some files exceed the maximum size of ${formatBytes(maxSize)}.`
              : `File exceeds the maximum size of ${formatBytes(maxSize)}.`,
          );
          continue;
        }

        const error = validateFile(file);

        if (error) {
          errors.push(error);
          continue;
        }

        validFiles.push({
          file,
          id: generateUniqueId(file),
          preview: createPreview(file),
        });
      }

      // 只有存在有效文件时才更新列表，非法文件只反馈错误。
      if (validFiles.length > 0) {
        // 先通知新增文件，再更新内部状态。
        onFilesAdded?.(validFiles);

        setState((prev) => {
          const newFiles = !multiple
            ? validFiles
            : [...prev.files, ...validFiles];
          onFilesChange?.(newFiles);
          return {
            ...prev,
            errors,
            files: newFiles,
          };
        });
      } else if (errors.length > 0) {
        setState((prev) => ({
          ...prev,
          errors,
        }));
      }

      // 处理完成后重置 input，允许用户再次选择同一文件。
      if (inputRef.current) {
        inputRef.current.value = "";
      }
    },
    [
      state.files,
      maxFiles,
      multiple,
      maxSize,
      validateFile,
      createPreview,
      generateUniqueId,
      clearFiles,
      onFilesChange,
      onFilesAdded,
    ],
  );

  const removeFile = useCallback(
    (id: string) => {
      setState((prev) => {
        const fileToRemove = prev.files.find((file) => file.id === id);
        if (
          fileToRemove?.preview &&
          fileToRemove.file instanceof File &&
          fileToRemove.file.type.startsWith("image/")
        ) {
          URL.revokeObjectURL(fileToRemove.preview);
        }

        const newFiles = prev.files.filter((file) => file.id !== id);
        onFilesChange?.(newFiles);

        return {
          ...prev,
          errors: [],
          files: newFiles,
        };
      });
    },
    [onFilesChange],
  );

  const clearErrors = useCallback(() => {
    setState((prev) => ({
      ...prev,
      errors: [],
    }));
  }, []);

  const handleDragEnter = useCallback((e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setState((prev) => ({ ...prev, isDragging: true }));
  }, []);

  const handleDragLeave = useCallback((e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.currentTarget.contains(e.relatedTarget as Node)) {
      return;
    }

    setState((prev) => ({ ...prev, isDragging: false }));
  }, []);

  const handleDragOver = useCallback((e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setState((prev) => ({ ...prev, isDragging: false }));

      // 禁用状态下忽略拖拽文件，和 input 行为保持一致。
      if (inputRef.current?.disabled) {
        return;
      }

      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        // 单文件模式只接收第一个文件。
        if (!multiple) {
          const file = e.dataTransfer.files[0];
          addFiles([file]);
        } else {
          addFiles(e.dataTransfer.files);
        }
      }
    },
    [addFiles, multiple],
  );

  const handleFileChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      if (e.target.files && e.target.files.length > 0) {
        addFiles(e.target.files);
      }
    },
    [addFiles],
  );

  const openFileDialog = useCallback(() => {
    if (inputRef.current) {
      inputRef.current.click();
    }
  }, []);

  const getInputProps = useCallback(
    (props: InputHTMLAttributes<HTMLInputElement> = {}) => {
      return {
        ...props,
        accept: props.accept || accept,
        multiple: props.multiple !== undefined ? props.multiple : multiple,
        onChange: handleFileChange,
        ref: inputRef,
        type: "file" as const,
      };
    },
    [accept, multiple, handleFileChange],
  );

  return [
    state,
    {
      addFiles,
      clearErrors,
      clearFiles,
      getInputProps,
      handleDragEnter,
      handleDragLeave,
      handleDragOver,
      handleDrop,
      handleFileChange,
      openFileDialog,
      removeFile,
    },
  ];
};

/**
 * 格式化文件大小。
 * @param bytes 字节数
 * @param decimals 小数位数
 * @returns 可读文件大小
 */
export const formatBytes = (bytes: number, decimals = 2): string => {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return Number.parseFloat((bytes / k ** i).toFixed(dm)) + sizes[i];
};
