import { Logger } from '@nestjs/common';

/**
 * Generic singleton factory for NestJS services
 *
 * This factory creates type-safe singleton accessors that allow non-NestJS modules
 * (like graph agents) to access service instances created by the NestJS DI container.
 *
 * Usage:
 * 1. Create singleton: const mySingleton = createSingleton<MyService>('MyService');
 * 2. In NestJS module: mySingleton.setInstance(service);
 * 3. Anywhere else: const service = mySingleton.getInstance();
 */

export interface SingletonAccessor<T> {
  /** Set the service instance (called from NestJS module) */
  setInstance: (service: T) => void;
  /** Get the service instance (returns null if not initialized) */
  getInstance: () => T | null;
  /** Check if the service is available */
  isAvailable: () => boolean;
}

/**
 * Create a type-safe singleton accessor for a service
 *
 * @param name - Name of the service (used for logging)
 * @returns SingletonAccessor with setInstance, getInstance, and isAvailable methods
 */
export function createSingleton<T>(name: string): SingletonAccessor<T> {
  let instance: T | null = null;
  const logger = new Logger(`${name}Singleton`);

  return {
    setInstance: (service: T): void => {
      instance = service;
      logger.log(`${name} singleton registered`);
    },
    getInstance: (): T | null => instance,
    isAvailable: (): boolean => instance !== null,
  };
}
