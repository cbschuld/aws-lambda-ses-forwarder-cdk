[v2.0.0] - 2025-03-26

Changed

- CDK Migration: Upgraded project from AWS CDK v1 to CDK v2.
- Unified Imports: Replaced individual module imports with consolidated imports from aws-cdk-lib to align with v2 best practices.
- Lambda Runtime Update: Updated the Lambda function runtime from NODEJS_16_X to NODEJS_18_X for improved performance and support.
- Refactoring: Replaced deprecated patterns (e.g., using cdk.Stack.of(this)) with the recommended Stack.of(this) syntax.
- Entry Point Update: Modified the entry script to use direct imports from aws-cdk-lib and improved context parameter validation.
