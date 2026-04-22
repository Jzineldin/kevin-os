#!/usr/bin/env bash
# Plan 01-07 — AWS Budgets creation (out-of-band).
#
# Why out-of-band?
#   AWS::Budgets::Budget CloudFormation resource is only supported in us-east-1.
#   Our primary region is eu-north-1, so we create the budget via `aws budgets`
#   against us-east-1 (Budgets is a global API but CFN-typed only in us-east-1).
#   SafetyStack still owns the SNS topic in eu-north-1 — Budgets publishes into
#   it cross-region (supported; Budgets is an account-global service).
#
# Idempotent: uses `aws budgets describe-budget` to skip creation if exists.
#
# Required env:
#   AWS_ACCOUNT_ID   default: resolved via sts:GetCallerIdentity
#   ALARM_TOPIC_ARN  default: resolved from KosSafety stack outputs
set -euo pipefail

ACCOUNT="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
BUDGET_NAME="kos-monthly"

if [ -z "${ALARM_TOPIC_ARN:-}" ]; then
  ALARM_TOPIC_ARN=$(aws cloudformation describe-stacks \
    --stack-name KosSafety \
    --region eu-north-1 \
    --query "Stacks[0].Outputs[?OutputKey=='AlarmTopicArn'].OutputValue" \
    --output text 2>/dev/null)
  if [ -z "$ALARM_TOPIC_ARN" ] || [ "$ALARM_TOPIC_ARN" = "None" ]; then
    # Fallback: enumerate topics in the stack
    ALARM_TOPIC_ARN=$(aws cloudformation list-stack-resources \
      --stack-name KosSafety \
      --region eu-north-1 \
      --query "StackResourceSummaries[?ResourceType=='AWS::SNS::Topic'].PhysicalResourceId" \
      --output text 2>/dev/null | head -1)
  fi
fi

if [ -z "$ALARM_TOPIC_ARN" ] || [ "$ALARM_TOPIC_ARN" = "None" ]; then
  echo "ERROR: Could not resolve ALARM_TOPIC_ARN. Set it explicitly or deploy KosSafety first." >&2
  exit 1
fi

echo "[info] Account: $ACCOUNT"
echo "[info] Budget:  $BUDGET_NAME"
echo "[info] SNS:     $ALARM_TOPIC_ARN"

# Idempotency check
if aws budgets describe-budget \
    --account-id "$ACCOUNT" \
    --budget-name "$BUDGET_NAME" \
    --region us-east-1 >/dev/null 2>&1; then
  echo "[OK] Budget $BUDGET_NAME already exists — skipping create."
  exit 0
fi

# Build the budget definition
BUDGET_JSON=$(cat <<JSON
{
  "BudgetName": "$BUDGET_NAME",
  "BudgetType": "COST",
  "TimeUnit": "MONTHLY",
  "BudgetLimit": { "Amount": "100", "Unit": "USD" },
  "CostTypes": {
    "IncludeTax": true,
    "IncludeSubscription": true,
    "UseBlended": false,
    "IncludeRefund": true,
    "IncludeCredit": false,
    "IncludeUpfront": true,
    "IncludeRecurring": true,
    "IncludeOtherSubscription": true,
    "IncludeSupport": true,
    "IncludeDiscount": true,
    "UseAmortized": false
  }
}
JSON
)

# Three notifications — 50 actual warn, 100 actual critical, 100 forecast
NOTIFICATIONS_JSON=$(cat <<JSON
[
  {
    "Notification": {
      "NotificationType": "ACTUAL",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 50,
      "ThresholdType": "ABSOLUTE_VALUE",
      "NotificationState": "ALARM"
    },
    "Subscribers": [
      { "SubscriptionType": "SNS", "Address": "$ALARM_TOPIC_ARN" }
    ]
  },
  {
    "Notification": {
      "NotificationType": "ACTUAL",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 100,
      "ThresholdType": "ABSOLUTE_VALUE",
      "NotificationState": "ALARM"
    },
    "Subscribers": [
      { "SubscriptionType": "SNS", "Address": "$ALARM_TOPIC_ARN" }
    ]
  },
  {
    "Notification": {
      "NotificationType": "FORECASTED",
      "ComparisonOperator": "GREATER_THAN",
      "Threshold": 100,
      "ThresholdType": "ABSOLUTE_VALUE",
      "NotificationState": "ALARM"
    },
    "Subscribers": [
      { "SubscriptionType": "SNS", "Address": "$ALARM_TOPIC_ARN" }
    ]
  }
]
JSON
)

aws budgets create-budget \
  --account-id "$ACCOUNT" \
  --budget "$BUDGET_JSON" \
  --notifications-with-subscribers "$NOTIFICATIONS_JSON" \
  --region us-east-1

echo "[OK] Budget $BUDGET_NAME created in account $ACCOUNT (us-east-1)"
echo "[OK] 3 notifications wired to $ALARM_TOPIC_ARN (eu-north-1)"
echo
echo "Next: click the AWS SNS subscription-confirmation email sent to the"
echo "subscribed address to unblock alarm delivery. The SNS topic policy"
echo "already scopes Budgets publish to this specific budget (T-01-SNS-01)."
