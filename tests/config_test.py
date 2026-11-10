from app.config import Settings, get_settings

s = get_settings()


#check if settings are working properly

print(s.aws_region)
print(s.bedrock_chat_model)
print(s.bedrock_embed_model)
print(s.s3_bucket)