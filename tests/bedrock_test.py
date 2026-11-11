import os
import json
import boto3
from dotenv import load_dotenv

load_dotenv(override=True)


#setup the client
client = boto3.client(
    "bedrock-runtime",
    region_name = os.getenv("AWS_REGION"),
    aws_access_key_id = os.getenv("AWS_ACCESS_KEY_ID"),
    aws_secret_access_key = os.getenv("AWS_SECRET_ACCESS_KEY")
)

#test 1: amazon titan embeddings
embedding_response = client.invoke_model(
    modelId = os.getenv("BEDROCK_EMBED_MODEL"),
    body = json.dumps({
        "inputText" : "Hello Amazon Bedrock",
        "dimensions" : 1024,
        "normalize" : True #normalization done by default 
    }),
    contentType = "application/json",
    accept = "application/json"
)

#read response and convert to python dict using json.loads
embed_data = json.loads(
    embedding_response["body"].read()
)

print("Embedding Dimensions: ", len(embed_data["embedding"]))


#test 2: amazon titan text generation
chat_response = client.converse(
    modelId = os.getenv("BEDROCK_CHAT_MODEL"),
    messages = [
        {
            "role" : "user",
            "content" : [{
                "text" : "Explain RAG in one sentence."
            }]
        }
    ],
    inferenceConfig={"maxTokens": 150},
)


print(
    "Nova Response: ",
    chat_response["output"]["message"]["content"][0]["text"]
)